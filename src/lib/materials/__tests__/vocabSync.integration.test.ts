/**
 * 词汇候选物化 + 主库同步的集成测试（真实 Prisma + 内置 mock provider，T12）。
 *
 * 覆盖的硬要求（§9）：
 * - **物化幂等**：同一条抽取被裁决两次只产生一条候选（AC-10）；
 * - **同步幂等**：连跑两次，第二次 `created` / `linked` 全 0；
 * - **E-04 只加来源**：主库已有同键词条时，字段级断言「一个字都没改」；
 * - **E-06 失败可重试**：失败写人话原因（不含绝对路径），修好之后重试能成功；
 * - **只有人确认过的词进词库**：未采纳的候选同步 0 条；
 * - **闸门联动**：候选未审完材料不会变 `ready`。
 *
 * 用例隔离靠**每个用例用自己的词条**（`sync-a1`、`sync-e04`…）：mock provider
 * 只会给出 `quick`，若不换词，前一个用例建出的主库词条会直接影响后一个的判定。
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

process.env.AI_CREDENTIALS_SECRET ??= 'ielts-integration-test-secret';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const { prisma, cleanup } = await createTestDb();

const { finalizeMaterialUpload } = await import('@/lib/materials/upload');
const { runPipelineTick } = await import('@/lib/materials/pipeline');
const { ensurePromptRegistry } = await import('@/lib/ai/registry');
const { bulkReviewExtractionAction } = await import('@/lib/actions/materialAnalysis');
const {
  bulkAcceptVocabularyCandidatesAction,
  materializeVocabularyCandidatesAction,
  retryVocabularySyncAction,
  reviewVocabularyCandidateAction,
  skipVocabularyCandidateAction,
  syncVocabularyCandidatesAction,
} = await import('@/lib/actions/materialVocabulary');
const {
  countNormalizationDrift,
  getMaterialVocabSummary,
  getReaderView,
  listVocabularyCandidates,
} = await import('@/lib/queries/materials');
const { MATERIAL_LIMITS } = await import('@/lib/constants');
const { materialsDir } = await import('@/lib/storage');

/**
 * 单 chunk 的短文本。
 *
 * 两个硬约束（踩过的坑）：
 * 1. **标题必须与正文同一行**：mock provider 的引用取自 `excerpt(baseline)`，
 *    而 `excerpt` 会在第一个 `.`/`！`/换行处截断。若标题后面跟换行，引用就只剩
 *    标题那几个字，`verifySourceQuote` 会因「太短（< 8 字符）」整条丢弃 ——
 *    表现是"一条 KEYWORD 都没有"，非常难从断言里看出来。
 * 2. 第一句要够长（≥ 8 字符），理由同上。
 */
function sampleText(title: string): string {
  return (
    `${title} is a sample passage for vocabulary candidate testing. `
    + 'Reading improves with deliberate practice and steady attention every day. '
    + 'Vocabulary breadth predicts comprehension more strongly than grammar knowledge does.'
  );
}

/**
 * 多 chunk 的长文本（约 9 块 × 1600 字符）。
 *
 * 为什么测试"同词多处出现"必须用长文本：mock 一次调用只产出一条 KEYWORD，
 * 且它的 `source_chunk_seq` 取的是**本批第一个** chunk（`mockChunkSeq`）。
 * 一个批次里的多块因此只会落一条 KEYWORD —— 想拿到两条同词候选，
 * 必须让材料跨**两个批次**（`chunksPerAiCall = 8`）。
 */
function longSampleText(marker: string, chunks = 9): string {
  const sentence =
    `${marker} deliberate practice makes vocabulary growth measurable and repeatable in ordinary study.`;
  const perChunk = Math.max(1, Math.floor(MATERIAL_LIMITS.chunkTargetChars / sentence.length));
  const parts: string[] = [];
  for (let index = 0; index < chunks * perChunk; index += 1) {
    parts.push(`${sentence} (#${index + 1})`);
  }
  return parts.join(' ');
}

const createdIds = new Set<string>();

function pasteForm(title: string, text: string): FormData {
  const formData = new FormData();
  formData.set(
    'meta',
    JSON.stringify({
      title,
      pastedText: text,
      source: { sourceType: 'user_upload', rightsConfirmed: true },
    }),
  );
  return formData;
}

async function importText(title: string, text = sampleText(title)): Promise<string> {
  const result = await finalizeMaterialUpload(pasteForm(title, text));
  if (!result.ok) throw new Error(`导入失败：${result.error}`);
  if (result.data.duplicateOf) throw new Error(`用例隔离被破坏：${title} 命中去重`);
  createdIds.add(result.data.materialId);
  return result.data.materialId;
}

async function tick(materialId: string) {
  const result = await runPipelineTick(materialId);
  if (!result.ok) throw new Error(`tick 失败：${result.error}`);
  return result.data;
}

async function settle(materialId: string) {
  let last = await tick(materialId);
  for (let index = 0; index < 12; index += 1) {
    const row = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true },
    });
    if (['review_required', 'partial', 'failed', 'cancelled', 'ready'].includes(row?.status ?? '')) {
      break;
    }
    last = await tick(materialId);
  }
  return last;
}

async function materialStatusOf(materialId: string): Promise<string | null> {
  const row = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { status: true },
  });
  return row?.status ?? null;
}

/**
 * 把所有 KEYWORD 抽取结果改成「已修改采纳」，并统一换成给定的词条。
 *
 * 为什么改 payload 而不是只改 reviewStatus：mock provider 永远给 `quick`，
 * 用例之间会互相污染主库（上一个用例建出的 quick 词条会让下一个用例走
 * `add_source` 而不是 `create`）。换词是唯一能保证用例独立的最小改动。
 */
async function acceptKeywordsAs(materialId: string, lemma: string): Promise<number> {
  const rows = await prisma.extractionResult.findMany({
    where: { materialId, kind: 'KEYWORD' },
    select: { id: true, payloadJson: true },
  });
  for (const row of rows) {
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    await prisma.extractionResult.update({
      where: { id: row.id },
      data: {
        reviewStatus: 'edited',
        editedPayloadJson: JSON.stringify({
          ...payload,
          lemma,
          pos: 'n',
          definition_zh: `（测试释义）${lemma}`,
        }),
        reviewedAt: new Date(),
      },
    });
  }
  return rows.length;
}

/** 调用「补建候选」（走真实的 action，含 best-effort 与结算）。 */
async function materialize(materialId: string) {
  const result = await materializeVocabularyCandidatesAction({ materialId });
  if (!result.ok) throw new Error(`补建失败：${result.error}`);
  return result.data;
}

async function candidateRows(materialId: string) {
  return prisma.vocabularyCandidate.findMany({
    where: { materialId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      lemma: true,
      normalizedLemma: true,
      pos: true,
      syncStatus: true,
      syncError: true,
      reviewStatus: true,
      existsInLibrary: true,
      existingItemId: true,
      syncedItemId: true,
      contextHash: true,
      surfaceForm: true,
    },
  });
}

/** 建一个独立的词库来源（避免用例之间抢同一个 MATERIAL 来源）。 */
async function importSource(title: string): Promise<string> {
  const created = await prisma.vocabularySource.create({
    data: { sourceType: 'IMPORT', title },
    select: { id: true },
  });
  return created.id;
}

beforeAll(async () => {
  await ensurePromptRegistry(prisma);
  await prisma.aIEngineSetting.create({ data: { id: 'default', externalAiEnabled: false } });
  await prisma.aIEngineSetting.updateMany({ data: { externalAiEnabled: false } });
});

afterAll(async () => {
  if (process.env.MATERIALS_TEST_CLEANUP !== '0') {
    await Promise.allSettled([
      ...Array.from(createdIds, async (id) => {
        try {
          await rm(join(materialsDir(), id), { recursive: true, force: true });
        } catch {
          // 清理失败不影响结论
        }
      }),
    ]);
  }
  await prisma.$disconnect();
  cleanup();
}, 60_000);

// ═════════════════════ ① 物化 ═════════════════════

describe('候选物化：来自已采纳的抽取结果，且幂等', () => {
  it('每条 KEYWORD 物化出一条候选，字段齐全、依据可回验', async () => {
    const materialId = await importText('物化样本');
    await settle(materialId);
    const keywordCount = await acceptKeywordsAs(materialId, 'sync-a1');
    expect(keywordCount).toBeGreaterThan(0);

    const result = await materialize(materialId);
    expect(result.created).toBe(keywordCount);
    expect(result.duplicates).toBe(0);
    expect(result.skippedNoLemma).toBe(0);
    expect(result.skippedUnverifiable).toBe(0);

    const rows = await candidateRows(materialId);
    expect(rows).toHaveLength(keywordCount);

    for (const row of rows) {
      expect(row.lemma).toBe('sync-a1');
      expect(row.normalizedLemma).toBe('sync-a1');
      expect(row.pos).toBe('n');
      expect(row.reviewStatus).toBe('draft');
      expect(row.syncStatus).toBe('pending');
      expect(row.contextHash).toMatch(/^[0-9a-f]{16}$/);
      expect(row.existsInLibrary).toBe(false);
      expect(row.existingItemId).toBeNull();
    }
    // 每段原文一条 → contextHash 各不相同（同一句才会被去重）
    expect(new Set(rows.map((row) => row.contextHash)).size).toBe(rows.length);

    // 候选必须能指回原文：contextSentence 在它自己的 chunk 里逐字可找到
    const detail = await listVocabularyCandidates(materialId);
    expect(detail).toHaveLength(keywordCount);
    const chunkTextById = new Map(
      (
        await prisma.contentChunk.findMany({
          where: { id: { in: detail.map((item) => item.chunkId) } },
          select: { id: true, text: true },
        })
      ).map((chunk) => [chunk.id, chunk.text]),
    );
    for (const item of detail) {
      expect(item.contextSentence.trim().length).toBeGreaterThan(0);
      expect(item.chunkSeq).not.toBeNull();
      expect(item.existsInLibrary).toBe(false);
      expect(chunkTextById.get(item.chunkId) ?? '').toContain(item.contextSentence);
    }
  });

  it('同一份材料再补建一次：created 为 0，duplicates 等于已有条数（AC-10）', async () => {
    const materialId = await importText('幂等物化样本');
    await settle(materialId);
    const keywordCount = await acceptKeywordsAs(materialId, 'sync-a2');

    const first = await materialize(materialId);
    expect(first.created).toBe(keywordCount);

    const second = await materialize(materialId);
    expect(second.created).toBe(0);
    expect(second.duplicates).toBe(keywordCount);
    expect(await prisma.vocabularyCandidate.count({ where: { materialId } })).toBe(keywordCount);
  });

  it('没有已采纳的抽取结果 → 一条候选都不建（AI 草稿不进候选表）', async () => {
    const materialId = await importText('未采纳样本');
    await settle(materialId);

    const result = await materialize(materialId);
    expect(result.created).toBe(0);
    expect(await prisma.vocabularyCandidate.count({ where: { materialId } })).toBe(0);
  });
});

// ═════════════════════ ② 闸门联动 ═════════════════════

describe('闸门：候选未审完，材料不会变 ready', () => {
  it('全部抽取结果采纳后仍停在 review_required，候选采纳后才 ready', async () => {
    const materialId = await importText('闸门样本');
    await settle(materialId);
    await acceptKeywordsAs(materialId, 'sync-b1');

    await materialize(materialId);
    expect(await prisma.vocabularyCandidate.count({ where: { materialId, reviewStatus: 'draft' } }))
      .toBeGreaterThan(0);

    // 把剩下的抽取结果也全部采纳（KEY_SENTENCE / PARAGRAPH_GIST …）
    const ids = (
      await prisma.extractionResult.findMany({ where: { materialId }, select: { id: true } })
    ).map((row) => row.id);
    const reviewed = await bulkReviewExtractionAction({
      materialId,
      ids,
      reviewStatus: 'accepted',
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    // 候选还是 draft → 闸门不放行（`pendingTotal` 里含词汇候选）
    expect(reviewed.data.materialStatus).toBe('review_required');
    expect(reviewed.data.gate.pendingTotal).toBeGreaterThan(0);

    const summary = await getMaterialVocabSummary(materialId);
    expect(summary.draft).toBe(summary.total);
    expect(reviewed.data.gate.pendingTotal).toBe(summary.draft);

    const candidateIds = (await candidateRows(materialId)).map((row) => row.id);
    const accepted = await bulkAcceptVocabularyCandidatesAction({
      materialId,
      ids: candidateIds,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.data.updated).toBe(candidateIds.length);
    expect(accepted.data.gate.pendingTotal).toBe(0);
    expect(accepted.data.materialStatus).toBe('ready');
    expect(await materialStatusOf(materialId)).toBe('ready');
  });
});

// ═════════════════════ ③ 同步：create + 只加来源 ═════════════════════

describe('同步：新建词条 + 只加来源（E-04）', () => {
  it('同词多处出现：只建一个词条、一条来源，其余按"来源已存在"跳过', async () => {
    // 需要跨批次的材料才能拿到两条以上同词候选（见 `longSampleText` 的注释）
    const materialId = await importText('同步新建样本', longSampleText('SyncC1'));
    await settle(materialId);
    const keywordCount = await acceptKeywordsAs(materialId, 'sync-c1');
    expect(keywordCount).toBeGreaterThan(1);
    await materialize(materialId);
    const ids = (await candidateRows(materialId)).map((row) => row.id);
    expect(ids.length).toBe(keywordCount);
    await bulkAcceptVocabularyCandidatesAction({ materialId, ids });

    const result = await syncVocabularyCandidatesAction({ materialId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(1);
    expect(result.data.failed).toBe(0);
    // 同词同源只能有一条 membership：其余候选的 membership 建出来就冲突 → skipped
    expect(result.data.linked + result.data.skipped).toBe(keywordCount - 1);

    const items = await prisma.vocabularyItem.findMany({
      where: { normalizedLemma: 'sync-c1' },
      select: { id: true, lemma: true, displayForm: true, pos: true, senseKey: true, sourceRef: true },
    });
    expect(items).toHaveLength(1);
    expect(items[0].lemma).toBe('sync-c1');
    expect(items[0].pos).toBe('n');
    expect(items[0].senseKey).toBe('default');
    expect(items[0].sourceRef).toBe(materialId);
    // displayForm 取原文真实写法（这句原文里出现了该词）
    expect(items[0].displayForm?.toLowerCase()).toBe('sync-c1');

    const memberships = await prisma.vocabularyItemSource.count({
      where: { itemId: items[0].id, sourceRef: materialId },
    });
    expect(memberships).toBe(1);

    const rows = await candidateRows(materialId);
    expect(rows.every((row) => row.syncStatus === 'synced')).toBe(true);
    expect(rows.every((row) => row.syncedItemId === items[0].id)).toBe(true);
    expect(rows.every((row) => row.syncError === null)).toBe(true);
  });

  it('同步幂等：连跑两次，第二次 created / linked / failed 全 0', async () => {
    const materialId = await importText('同步幂等样本');
    await settle(materialId);
    await acceptKeywordsAs(materialId, 'sync-c2');
    await materialize(materialId);
    const ids = (await candidateRows(materialId)).map((row) => row.id);
    await bulkAcceptVocabularyCandidatesAction({ materialId, ids });

    const first = await syncVocabularyCandidatesAction({ materialId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toBe(1);

    const second = await syncVocabularyCandidatesAction({ materialId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.created).toBe(0);
    expect(second.data.linked).toBe(0);
    expect(second.data.failed).toBe(0);
    // 词条没有被建成两条
    expect(await prisma.vocabularyItem.count({ where: { normalizedLemma: 'sync-c2' } })).toBe(1);
  });

  it('E-04：主库已有词条 → 只加来源，词条字段一个字都不改', async () => {
    const materialId = await importText('只加来源样本');
    await settle(materialId);
    await acceptKeywordsAs(materialId, 'sync-e04');
    await materialize(materialId);
    const ids = (await candidateRows(materialId)).map((row) => row.id);
    await bulkAcceptVocabularyCandidatesAction({ materialId, ids });

    // 预先造一条"人工润色过"的主库词条（不同来源）
    const manualSource = await importSource('人工词库（测试）');
    const existing = await prisma.vocabularyItem.create({
      data: {
        lemma: 'sync-e04',
        displayForm: 'sync-e04',
        normalizedLemma: 'sync-e04',
        pos: 'n',
        language: 'en',
        senseKey: 'default',
        definitionZh: '人工润色的释义：不许被 AI 覆盖',
        definitionEn: 'hand written',
        examplesJson: JSON.stringify(['An example written by a human.']),
        collocationsJson: JSON.stringify(['hand made collocation']),
        sourceId: manualSource,
        sourceRef: 'manual-ref',
        license: 'CC-BY-4.0',
      },
      select: { id: true },
    });
    const before = await prisma.vocabularyItem.findUnique({
      where: { id: existing.id },
      select: {
        lemma: true,
        normalizedLemma: true,
        displayForm: true,
        pos: true,
        senseKey: true,
        definitionZh: true,
        definitionEn: true,
        examplesJson: true,
        collocationsJson: true,
        sourceId: true,
        sourceRef: true,
        license: true,
        status: true,
        archivedAt: true,
        updatedAt: true,
      },
    });

    const result = await syncVocabularyCandidatesAction({ materialId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(0);
    expect(result.data.linked).toBe(1);
    expect(result.data.failed).toBe(0);

    // 字段级断言：逐字段比对（含 updatedAt —— 证明根本没有 UPDATE 语句打过去）
    const after = await prisma.vocabularyItem.findUnique({
      where: { id: existing.id },
      select: {
        lemma: true,
        normalizedLemma: true,
        displayForm: true,
        pos: true,
        senseKey: true,
        definitionZh: true,
        definitionEn: true,
        examplesJson: true,
        collocationsJson: true,
        sourceId: true,
        sourceRef: true,
        license: true,
        status: true,
        archivedAt: true,
        updatedAt: true,
      },
    });
    expect(after).toEqual(before);
    expect(after?.definitionZh).toBe('人工润色的释义：不许被 AI 覆盖');
    expect(after?.collocationsJson).toBe(JSON.stringify(['hand made collocation']));

    // 新来源记在这条词条名下，且指向这份材料
    const membership = await prisma.vocabularyItemSource.findFirst({
      where: { itemId: existing.id, sourceRef: materialId },
      select: { sourceId: true, note: true },
    });
    expect(membership).not.toBeNull();
    expect(membership?.note).toContain('来自材料');

    // 候选侧记着"已同步到哪条词条"
    const rows = await candidateRows(materialId);
    expect(rows[0].syncStatus).toBe('synced');
    expect(rows[0].syncedItemId).toBe(existing.id);
    expect(rows[0].existsInLibrary).toBe(true);
    expect(rows[0].existingItemId).toBe(existing.id);

    // 列表 DTO 也会把主库释义带出来（只读展示）
    const detail = await listVocabularyCandidates(materialId);
    expect(detail[0].libraryDefinitionZh).toBe('人工润色的释义：不许被 AI 覆盖');
    expect(detail[0].libraryLemma).toBe('sync-e04');
  });

  it('未采纳的候选同步结果为 0（只有人确认过的词才进词库）', async () => {
    const materialId = await importText('未采纳同步样本');
    await settle(materialId);
    await acceptKeywordsAs(materialId, 'sync-c3');
    await materialize(materialId);

    const result = await syncVocabularyCandidatesAction({ materialId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(0);
    expect(result.data.linked).toBe(0);
    expect(await prisma.vocabularyItem.count({ where: { normalizedLemma: 'sync-c3' } })).toBe(0);
  });
});

// ═════════════════════ ④ E-06 失败与重试 ═════════════════════

describe('E-06：失败写人话原因，修好之后能重试成功', () => {
  it('词库里只有一条「已归档」的同名词条 → 失败可读、可重试', async () => {
    const materialId = await importText('同步失败样本');
    await settle(materialId);
    await acceptKeywordsAs(materialId, 'sync-f1');
    await materialize(materialId);
    const ids = (await candidateRows(materialId)).map((row) => row.id);
    await bulkAcceptVocabularyCandidatesAction({ materialId, ids });

    // 已归档词条仍占着唯一键（`archivedAt` 只是业务标记），于是"建不了也加不了来源"
    const archivedSource = await importSource('已归档词库（测试）');
    const archived = await prisma.vocabularyItem.create({
      data: {
        lemma: 'sync-f1',
        normalizedLemma: 'sync-f1',
        pos: 'n',
        language: 'en',
        senseKey: 'default',
        definitionZh: '旧释义',
        sourceId: archivedSource,
        archivedAt: new Date(),
      },
      select: { id: true },
    });

    const failedRun = await syncVocabularyCandidatesAction({ materialId });
    expect(failedRun.ok).toBe(true);
    if (!failedRun.ok) return;
    expect(failedRun.data.failed).toBeGreaterThan(0);
    expect(failedRun.data.created).toBe(0);

    const failedRows = await candidateRows(materialId);
    const failed = failedRows.filter((row) => row.syncStatus === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const row of failed) {
      expect((row.syncError ?? '').length).toBeGreaterThan(0);
      // 人话：不含绝对路径、不含堆栈标记
      expect(row.syncError ?? '').not.toMatch(/\/(Users|private|var|tmp|opt|home)\//);
      expect(row.syncError ?? '').not.toContain('    at ');
      expect((row.syncError ?? '').length).toBeLessThanOrEqual(201);
    }
    expect(failed[0].syncError).toContain('已归档');

    const summary = await getMaterialVocabSummary(materialId);
    expect(summary.failed).toBe(failed.length);

    // 用户按提示去词库恢复那条词条后重试
    await prisma.vocabularyItem.update({
      where: { id: archived.id },
      data: { archivedAt: null },
    });

    const retry = await retryVocabularySyncAction({ materialId });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.reset).toBe(failed.length);
    expect(retry.data.failed).toBe(0);
    expect(retry.data.linked).toBeGreaterThan(0);

    const afterRows = await candidateRows(materialId);
    expect(afterRows.every((row) => row.syncStatus === 'synced')).toBe(true);
    expect(afterRows.every((row) => row.syncError === null)).toBe(true);
    // 恢复的是同一条词条：没有新建第二条
    expect(await prisma.vocabularyItem.count({ where: { normalizedLemma: 'sync-f1' } })).toBe(1);
  });
});

// ═════════════════════ ⑤ 裁决与跳过 ═════════════════════

describe('裁决：编辑要重算归一化键，跳过的两个字段必须一致', () => {
  it('修改后采纳：换词条会重算 normalizedLemma，并能同步成新词', async () => {
    const materialId = await importText('编辑候选样本');
    await settle(materialId);
    await acceptKeywordsAs(materialId, 'sync-g1');
    await materialize(materialId);
    const target = (await candidateRows(materialId))[0];

    const edited = await reviewVocabularyCandidateAction({
      id: target.id,
      reviewStatus: 'edited',
      lemma: 'Sync-G1-Edited,',
      pos: 'v',
      definitionZh: '（用户改写）被编辑过的释义',
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    // 展示词条保留大小写、只剥两端标点；归一化键是小写
    expect(edited.data.lemma).toBe('Sync-G1-Edited');
    expect(edited.data.normalizedLemma).toBe('sync-g1-edited');
    expect(edited.data.pos).toBe('v');

    const row = await prisma.vocabularyCandidate.findUnique({
      where: { id: target.id },
      select: { normalizedLemma: true, pos: true, reviewStatus: true, definitionZh: true },
    });
    expect(row?.normalizedLemma).toBe('sync-g1-edited');
    expect(row?.reviewStatus).toBe('edited');
    expect(row?.definitionZh).toBe('（用户改写）被编辑过的释义');

    const sync = await syncVocabularyCandidatesAction({ materialId, ids: [target.id] });
    expect(sync.ok).toBe(true);
    if (!sync.ok) return;
    expect(sync.data.created + sync.data.linked).toBe(1);
    // 用编辑后的词条建词条（不是原来的 sync-g1）
    expect(await prisma.vocabularyItem.count({ where: { normalizedLemma: 'sync-g1-edited' } }))
      .toBe(1);
  });

  it('「不进词库」= 已拒绝 + 已跳过（不留「已拒绝但待同步」的矛盾态）', async () => {
    const materialId = await importText('跳过候选样本');
    await settle(materialId);
    await acceptKeywordsAs(materialId, 'sync-g2');
    await materialize(materialId);
    const ids = (await candidateRows(materialId)).map((row) => row.id);
    await bulkAcceptVocabularyCandidatesAction({ materialId, ids });

    const skipped = await skipVocabularyCandidateAction({ id: ids[0] });
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(skipped.data.reviewStatus).toBe('rejected');
    expect(skipped.data.syncStatus).toBe('skipped');

    const row = await prisma.vocabularyCandidate.findUnique({
      where: { id: ids[0] },
      select: { reviewStatus: true, syncStatus: true },
    });
    expect(row?.reviewStatus).toBe('rejected');
    expect(row?.syncStatus).toBe('skipped');

    // 被跳过的候选不会再进同步队列
    const sync = await syncVocabularyCandidatesAction({ materialId, ids: [ids[0]] });
    expect(sync.ok).toBe(true);
    if (!sync.ok) return;
    expect(sync.data.created).toBe(0);
    expect(sync.data.linked).toBe(0);
    expect(await prisma.vocabularyItem.count({ where: { normalizedLemma: 'sync-g2' } })).toBe(0);
  });

  it('已同步的候选不能再跳过（跳过不会把词从词库里删掉）', async () => {
    const materialId = await importText('已同步跳过样本');
    await settle(materialId);
    await acceptKeywordsAs(materialId, 'sync-g3');
    await materialize(materialId);
    const ids = (await candidateRows(materialId)).map((row) => row.id);
    await bulkAcceptVocabularyCandidatesAction({ materialId, ids });
    const sync = await syncVocabularyCandidatesAction({ materialId });
    expect(sync.ok).toBe(true);

    const result = await skipVocabularyCandidateAction({ id: ids[0] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
  });
});

// ═════════════════════ ⑥ 阅读器的词汇气泡（U-2） ═════════════════════

/**
 * Reader 用例专用词。
 *
 * 必须同时满足两个条件，否则 hint 会被**静默丢弃**（这条踩过一次）：
 *
 * 1. 真实出现在 `sourceQuote` 的区间**内**：`locateHint` 先在块内定位引用，
 *    再在引用区间里找词，落在区间外一律返回 null（宁可不显示，也不把高亮
 *    画到错的位置）。mock 的引用取自第一句，所以词必须写进第一句 —— 不能像
 *    其它用例那样"事后把 lemma 换成 sync-g1"。
 * 2. 主库里没有：否则「物化前后都还是 AI 释义」的断言会被别的用例污染。
 */
const READER_WORD = 'bubbleword';

function readerSampleText(title: string): string {
  return (
    `${title} introduces ${READER_WORD} as a sample passage for vocabulary candidate testing. `
    + 'Reading improves with deliberate practice and steady attention every day. '
    + 'Vocabulary breadth predicts comprehension more strongly than grammar knowledge does.'
  );
}

describe('词汇辅助模式：hint 带上 candidateId，且主库释义优先', () => {
  it('候选物化后 hint.candidateId 有值；主库有释义时改用主库并标记来源', async () => {
    const materialId = await importText('词汇气泡样本', readerSampleText('词汇气泡样本'));
    await settle(materialId);
    await acceptKeywordsAs(materialId, READER_WORD);

    const before = await getReaderView(materialId, 'vocab_assist');
    expect(before).not.toBeNull();
    const hintsBefore = (before?.chunks ?? []).flatMap((chunk) => chunk.hints);
    expect(hintsBefore.length).toBeGreaterThan(0);
    expect(hintsBefore[0].lemma).toBe(READER_WORD);
    // 还没物化候选 → 没有 candidateId，释义来自 AI
    expect(hintsBefore[0].candidateId).toBeNull();
    expect(hintsBefore[0].definitionSource).toBe('ai');
    expect(hintsBefore[0].definitionZh).toBe(`（测试释义）${READER_WORD}`);

    await materialize(materialId);
    const candidates = await candidateRows(materialId);
    expect(candidates.length).toBeGreaterThan(0);

    const afterMaterialize = await getReaderView(materialId, 'vocab_assist');
    const hintsAfter = (afterMaterialize?.chunks ?? []).flatMap((chunk) => chunk.hints);
    expect(hintsAfter[0].candidateId).not.toBeNull();
    expect(hintsAfter[0].candidateId).toBe(candidates[0].id);
    // 主库还没有这个词 → 仍然标注为 AI 释义
    expect(hintsAfter[0].definitionSource).toBe('ai');

    // 采纳并同步进主库，然后把主库释义改成"人工版本"
    const ids = candidates.map((row) => row.id);
    await bulkAcceptVocabularyCandidatesAction({ materialId, ids });
    const sync = await syncVocabularyCandidatesAction({ materialId });
    expect(sync.ok).toBe(true);
    await prisma.vocabularyItem.updateMany({
      where: { normalizedLemma: READER_WORD },
      data: { definitionZh: '主库人工释义：泡泡词（人工核对）' },
    });

    const afterSync = await getReaderView(materialId, 'vocab_assist');
    const hintsFinal = (afterSync?.chunks ?? []).flatMap((chunk) => chunk.hints);
    expect(hintsFinal[0].definitionZh).toBe('主库人工释义：泡泡词（人工核对）');
    // 关键：主库释义是人确认过的，不该再挂「AI 辅助」的标注
    expect(hintsFinal[0].definitionSource).toBe('library');
    // 位置不变（高亮不能因为换释义而漂移）
    expect(hintsFinal[0].start).toBe(hintsBefore[0].start);
    expect(hintsFinal[0].end).toBe(hintsBefore[0].end);
  });

  it('原文模式读不到任何 hint（仍然不触碰 AI 表）', async () => {
    const materialId = await importText('原文模式样本', readerSampleText('原文模式样本'));
    await settle(materialId);
    await acceptKeywordsAs(materialId, READER_WORD);
    await materialize(materialId);

    const original = await getReaderView(materialId, 'original');
    expect(original).not.toBeNull();
    for (const chunk of original?.chunks ?? []) {
      expect(chunk.hints).toEqual([]);
    }
  });
});

// ═════════════ ⑦ §A 历史归一化键（normalization drift） ═════════════

/**
 * 手工种一条「归一化键是旧版本」的主库词条。
 *
 * 模拟 v2.3 时期落库、T12 之后从未重算过的行：`lemma` 是弯撇号形式，
 * `normalizedLemma` 也停在旧空间（旧算法不折叠弯撇号）。
 */
async function seedLegacyLibraryItem(input: {
  lemma: string;
  normalizedLemma: string;
  definitionZh: string;
  suffix: string;
}): Promise<string> {
  const source = await prisma.vocabularySource.create({
    data: { sourceType: 'IMPORT', title: `遗留词表-${input.suffix}` },
  });
  const item = await prisma.vocabularyItem.create({
    data: {
      lemma: input.lemma,
      normalizedLemma: input.normalizedLemma,
      pos: 'n',
      language: 'en',
      senseKey: 'default',
      definitionZh: input.definitionZh,
      sourceId: source.id,
    },
  });
  return item.id;
}

describe('§A 历史归一化键：按原词形兜底匹配，不重复建词条', () => {
  it("库里是 `don’t`（旧键 don’t），候选是 don't → 只加来源，词条一字不变", async () => {
    const legacyId = await seedLegacyLibraryItem({
      lemma: 'don\u2019t',
      normalizedLemma: 'don\u2019t',
      definitionZh: '人工释义：不要',
      suffix: 'apostrophe',
    });
    const before = await prisma.vocabularyItem.findUnique({ where: { id: legacyId } });
    const countBefore = await prisma.vocabularyItem.count();

    const materialId = await importText('遗留键样本A');
    await settle(materialId);
    // 候选用 ASCII 撇号 —— 新键 `don't` 在主库里查不到
    await acceptKeywordsAs(materialId, "don't");
    await materialize(materialId);
    const ids = (await candidateRows(materialId)).map((row) => row.id);
    await bulkAcceptVocabularyCandidatesAction({ materialId, ids });

    const sync = await syncVocabularyCandidatesAction({ materialId });
    expect(sync.ok).toBe(true);
    if (!sync.ok) return;

    // ① 没有新建词条，只加了来源
    expect(sync.data.created).toBe(0);
    expect(sync.data.linked).toBe(1);
    expect(sync.data.legacyMatched).toBe(1);
    expect(await prisma.vocabularyItem.count()).toBe(countBefore);

    // ② 主库那一条逐字段没变（尤其 normalizedLemma —— 我们不回写用户数据）
    const after = await prisma.vocabularyItem.findUnique({ where: { id: legacyId } });
    expect(after).toEqual(before);

    // ③ 来源记到了那条老词条上，并写明"按原词形匹配"
    const membership = await prisma.vocabularyItemSource.findFirst({
      where: { itemId: legacyId, sourceRef: materialId },
      select: { note: true },
    });
    expect(membership?.note).toContain('来自材料：');
    expect(membership?.note).toContain('按原词形匹配到历史词条');
  });

  it('库里确实没有该词时仍然 create（兜底不是"永远只加来源"）', async () => {
    const countBefore = await prisma.vocabularyItem.count();
    const materialId = await importText('遗留键样本B');
    await settle(materialId);
    await acceptKeywordsAs(materialId, 'neverlistedword');
    await materialize(materialId);
    const ids = (await candidateRows(materialId)).map((row) => row.id);
    await bulkAcceptVocabularyCandidatesAction({ materialId, ids });

    const sync = await syncVocabularyCandidatesAction({ materialId });
    expect(sync.ok).toBe(true);
    if (!sync.ok) return;
    expect(sync.data.created).toBe(1);
    expect(sync.data.legacyMatched).toBe(0);
    expect(await prisma.vocabularyItem.count()).toBe(countBefore + 1);
    expect(
      await prisma.vocabularyItem.count({ where: { normalizedLemma: 'neverlistedword' } }),
    ).toBe(1);
  });

  it('countNormalizationDrift 数得出旧键词条，且新键词条不计入', async () => {
    const baseline = await countNormalizationDrift();
    await seedLegacyLibraryItem({
      lemma: 'it\u2019s',
      normalizedLemma: 'it\u2019s',
      definitionZh: '人工释义：它是',
      suffix: 'count',
    });
    // 一条键正确的新词条：不该被计入
    const source = await prisma.vocabularySource.create({
      data: { sourceType: 'IMPORT', title: '新词表-count' },
    });
    await prisma.vocabularyItem.create({
      data: {
        lemma: 'Café',
        normalizedLemma: 'café',
        pos: 'n',
        language: 'en',
        senseKey: 'default',
        sourceId: source.id,
      },
    });

    // baseline 里已经含前面用例种下的那条，新增一条旧键 → +1，新键 +0
    expect(await countNormalizationDrift()).toBe(baseline + 1);
  });
});
