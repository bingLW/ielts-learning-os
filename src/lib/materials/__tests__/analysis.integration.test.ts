/**
 * AI 分析审核的集成测试（真实 Prisma + 内置 mock provider + 真实 action）。
 *
 * 覆盖 T10 最硬的四条：
 * - **闸门落库**：逐条/批量裁决完 → `review_required → ready`；
 * - **丢失确认**：有结果被丢弃时**绝不自动 ready**，必须走
 *   `confirmPartialUseAction` 才转 `partial`；
 * - **不可覆盖**：`editedPayload` 只写 `editedPayloadJson`，AI 原始 `payloadJson` 一字不动；
 * - **续跑真的能跑**：`continueAnalysisAction` 重开同一个 job 后，下一个 tick
 *   必须真的继续调用 AI（这正是「只重开 job 不改额度」会踩的坑）。
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
const { getLatestSummary } = await import('@/lib/services/materialExtractionRepo');
const { readMaterialReviewGate } = await import('@/lib/services/materialReviewSettle');
const { MATERIAL_LIMITS } = await import('@/lib/constants');
const { materialsDir } = await import('@/lib/storage');
// T11 起 `generating` 是真实生成器：此时分析结果还全是 draft（没人采纳过），
// 因此它会带着"没有出题依据"的原因回到 review_required。
const { GENERATING_NO_ANCHOR_REASON } = await import(
  '@/lib/materials/pipeline/stages/generating'
);
const {
  reviewExtractionResultAction,
  bulkReviewExtractionAction,
  regenerateMaterialSummaryAction,
  skipExerciseGenerationAction,
  continueAnalysisAction,
  confirmPartialUseAction,
} = await import('@/lib/actions/materialAnalysis');
// T12：采纳关键词会顺带物化词汇候选，候选也要审完材料才会 ready
const { bulkAcceptVocabularyCandidatesAction } = await import('@/lib/actions/materialVocabulary');

const TEXT =
  'Reading is a skill that improves with deliberate practice. '
  + 'Vocabulary breadth predicts comprehension more strongly than grammar knowledge.';

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

/** 每个样本正文互不相同，避免命中 contentHash 去重（同 pipeline 集成测试）。 */
async function importText(title: string, text = `${title}：${TEXT}`): Promise<string> {
  const result = await finalizeMaterialUpload(pasteForm(title, text));
  if (!result.ok) throw new Error(`导入失败：${result.error}`);
  if (result.data.duplicateOf) {
    throw new Error(`用例隔离被破坏：${title} 命中了去重（${result.data.duplicateOf}）`);
  }
  createdIds.add(result.data.materialId);
  return result.data.materialId;
}

async function tick(materialId: string) {
  const result = await runPipelineTick(materialId);
  if (!result.ok) throw new Error(`tick 失败：${result.error}`);
  return result.data;
}

/** 连续 tick 直到材料进入待审核（分析完成、停在练习生成之前）。 */
async function runToReviewRequired(materialId: string): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    const status = await materialStatusOf(materialId);
    if (status === 'review_required' || status === 'failed' || status === 'partial') return;
    await tick(materialId);
  }
  throw new Error(`材料没有进入待审核（当前：${await materialStatusOf(materialId)}）`);
}

async function materialStatusOf(materialId: string) {
  const row = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { status: true },
  });
  return row?.status ?? 'missing';
}

async function latestJob(materialId: string) {
  return prisma.processingJob.findFirst({
    where: { materialId },
    orderBy: { startedAt: 'desc' },
  });
}

async function extractionIds(materialId: string): Promise<string[]> {
  const rows = await prisma.extractionResult.findMany({
    where: { materialId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => row.id);
}

/**
 * 把该材料所有「待审核」的词汇候选一键采纳（T12）。
 *
 * 为什么"全部审完 → ready"这条链多了一步：采纳关键词抽取结果时会**顺带物化**
 * 词汇候选（`VocabularyCandidate`，状态 `draft`），而候选同样是 AI 产出、等人点头
 * 的东西 —— 闸门的 `pendingCandidates` 就是为了让它们挡住 `ready`。不审完候选，
 * 材料会永远停在 `review_required`，这不是 bug，是 E-01「候选与主库物理分离、
 * 必须人确认」的直接后果。
 *
 * @returns 实际被采纳的条数（0 表示这份材料没产生候选）
 */
async function acceptVocabCandidates(materialId: string): Promise<number> {
  const ids = (
    await prisma.vocabularyCandidate.findMany({
      where: { materialId, reviewStatus: 'draft' },
      select: { id: true },
    })
  ).map((row) => row.id);
  if (ids.length === 0) return 0;
  const result = await bulkAcceptVocabularyCandidatesAction({ materialId, ids });
  if (!result.ok) throw new Error(`采纳词汇候选失败：${result.error}`);
  return result.data.updated;
}

/** 一段长正文（≈1800 字符），用来稳定产出多个 chunk。 */
const LONG_PARA =
  'Reading is a skill that improves with deliberate practice and steady feedback from a careful teacher. ';

/** 两段长正文 → 至少 2 个 chunk（用于"已分析 / 未分析"混合的场景）。 */
function multiChunkText(seed: string): string {
  const paragraph = `${seed} ${LONG_PARA.repeat(24)}`;
  return `${paragraph}\n\n${paragraph}`;
}

/**
 * 删掉**最后一个** chunk 的提取结果，模拟「这一块还没分析」。
 *
 * 为什么这样造现场：`analyzing` 现在会跳过已有 `ExtractionResult` 的 chunk，
 * 所以「部分分析完」= 一部分 chunk 有结果、另一部分没有。
 *
 * @returns 被清空的 chunkId
 */
async function dropLastChunkResults(materialId: string): Promise<string> {
  const chunks = await prisma.contentChunk.findMany({
    where: { materialId },
    orderBy: { seq: 'asc' },
    select: { id: true },
  });
  if (chunks.length < 2) {
    throw new Error(`用例需要 ≥2 个 chunk，实际 ${chunks.length} 个`);
  }
  const last = chunks[chunks.length - 1].id;
  await prisma.extractionResult.deleteMany({ where: { materialId, chunkId: last } });
  return last;
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

describe('审核闸门落库：全部审完 → ready', () => {
  it('批量采纳后材料变成 ready，且闸门理由是「全部核验通过」', async () => {
    const materialId = await importText('全部采纳样本');
    await runToReviewRequired(materialId);

    // 先确认这次分析没有被丢弃的结果（否则应该走「部分可用」而不是 ready）。
    // 注意：`generating` 占位阶段会覆盖 progressJson，批次口径的 dropped 字段此时已不存在，
    // 所以这里按 0 处理；真正证明"没有丢弃"的是下面的 `requiresPartialConfirm === false`
    // （有丢弃时闸门规则 ② 会强制它为 true）。
    const job = await latestJob(materialId);
    const progress = JSON.parse(job?.progressJson ?? '{}') as { droppedUnverifiable?: number };
    expect(progress.droppedUnverifiable ?? 0).toBe(0);

    const ids = await extractionIds(materialId);
    expect(ids.length).toBeGreaterThan(0);

    const result = await bulkReviewExtractionAction({
      materialId,
      ids,
      reviewStatus: 'accepted',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.updated).toBe(ids.length);
    // T12：采纳关键词会**顺带物化**词汇候选（draft）—— 它们同样是"AI 产出、等人点头"
    // 的东西，所以材料现在停在 review_required，等这批候选也被裁决。
    expect(result.data.vocabMaterialized).toBeGreaterThan(0);
    expect(result.data.materialStatus).toBe('review_required');
    expect(result.data.gate.pendingTotal).toBe(result.data.vocabMaterialized);

    expect(await acceptVocabCandidates(materialId)).toBe(result.data.vocabMaterialized);
    expect(await materialStatusOf(materialId)).toBe('ready');

    // 候选审完后的最终闸门结论（与页面 `readMaterialReviewGate` 是同一个函数）
    const gate = await readMaterialReviewGate(materialId);
    expect(gate.nextStatus).toBe('ready');
    expect(gate.pendingTotal).toBe(0);
    expect(gate.requiresPartialConfirm).toBe(false);

    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { statusReason: true },
    });
    expect(material?.statusReason).toBe('全部 AI 结果已审核，原文依据核验通过');
  });

  it('批量拒绝同样可以收口（拒绝不是待审）；定稿后不再接受新的裁决', async () => {
    const materialId = await importText('批量拒绝样本');
    await runToReviewRequired(materialId);

    const ids = await extractionIds(materialId);
    const result = await bulkReviewExtractionAction({
      materialId,
      ids,
      reviewStatus: 'rejected',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updated).toBe(ids.length);
    expect(result.data.materialStatus).toBe('ready');

    // ready 之后材料已定稿：再裁决一律被前置断言拦住（避免"已经定稿又被人偷偷改掉"）
    const again = await bulkReviewExtractionAction({
      materialId,
      ids,
      reviewStatus: 'accepted',
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe('PRECONDITION');
    expect(await materialStatusOf(materialId)).toBe('ready');
  });

  it('不属于本材料的 id 被忽略（不报错、不越权写库）', async () => {
    const otherId = await importText('别的材料样本');
    await runToReviewRequired(otherId);

    const targetId = await importText('目标材料样本');
    await runToReviewRequired(targetId);
    const foreign = (await extractionIds(otherId)).slice(0, 1);
    expect(foreign.length).toBe(1);

    const result = await bulkReviewExtractionAction({
      materialId: targetId,
      ids: foreign,
      reviewStatus: 'accepted',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updated).toBe(0);

    // 别的材料那条仍是 draft，没有被越权改掉
    const row = await prisma.extractionResult.findUnique({
      where: { id: foreign[0] },
      select: { reviewStatus: true },
    });
    expect(row?.reviewStatus).toBe('draft');
  });
});

describe('有结果被丢弃 → 必须用户确认才能转 partial', () => {
  it('审完后仍是 review_required（requiresPartialConfirm），确认后转 partial', async () => {
    const materialId = await importText('部分可用样本');
    await runToReviewRequired(materialId);

    const job = await latestJob(materialId);
    if (!job) throw new Error('缺少 job');
    // 造出「有 2 条结果因原文依据无法核验被丢弃」的现场
    const progress = JSON.parse(job.progressJson ?? '{}') as Record<string, unknown>;
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        progressJson: JSON.stringify({ ...progress, droppedUnverifiable: 2 }),
      },
    });

    const ids = await extractionIds(materialId);
    const reviewed = await bulkReviewExtractionAction({
      materialId,
      ids,
      reviewStatus: 'accepted',
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;

    // T12：词汇候选先挡住一步（它们也是待审项），审完之后才轮到"丢弃确认"
    expect(reviewed.data.materialStatus).toBe('review_required');
    expect(reviewed.data.gate.pendingTotal).toBe(reviewed.data.vocabMaterialized);
    await acceptVocabCandidates(materialId);

    // 关键：全部审完之后仍然不能 ready
    const afterCandidates = await readMaterialReviewGate(materialId);
    expect(afterCandidates.allReviewed).toBe(true);
    expect(afterCandidates.requiresPartialConfirm).toBe(true);
    expect(afterCandidates.reasonZh).toContain('2 条结果因原文依据无法核验已丢弃');
    expect(afterCandidates.nextStatus).toBe('review_required');
    expect(await materialStatusOf(materialId)).toBe('review_required');

    const confirmed = await confirmPartialUseAction({ materialId });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.data.materialStatus).toBe('partial');
    expect(confirmed.data.droppedUnverifiable).toBe(2);

    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true, statusReason: true },
    });
    expect(material?.status).toBe('partial');
    expect(material?.statusReason).toContain('已按部分可用继续');
  });

  it('还有待审项时不许确认部分可用（防止绕过审核）', async () => {
    const materialId = await importText('绕过审核样本');
    await runToReviewRequired(materialId);

    const job = await latestJob(materialId);
    if (!job) throw new Error('缺少 job');
    const progress = JSON.parse(job.progressJson ?? '{}') as Record<string, unknown>;
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { progressJson: JSON.stringify({ ...progress, droppedUnverifiable: 1 }) },
    });

    const result = await confirmPartialUseAction({ materialId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(result.error).toContain('没审核');
    expect(await materialStatusOf(materialId)).toBe('review_required');
  });

  it('全部核验通过的材料不许降级为 partial', async () => {
    const materialId = await importText('不该降级样本');
    await runToReviewRequired(materialId);
    const ids = await extractionIds(materialId);
    await bulkReviewExtractionAction({ materialId, ids, reviewStatus: 'accepted' });
    // T12：词汇候选也要审完，否则材料根本到不了 ready，这条用例就退化成"待审项没审完"
    await acceptVocabCandidates(materialId);
    expect(await materialStatusOf(materialId)).toBe('ready');

    const result = await confirmPartialUseAction({ materialId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(await materialStatusOf(materialId)).toBe('ready');
  });
});

describe('editedPayload 不覆盖 AI 原始输出', () => {
  it('单条「修改后采纳」只写 editedPayloadJson', async () => {
    const materialId = await importText('编辑裁决样本');
    await runToReviewRequired(materialId);

    const ids = await extractionIds(materialId);
    const target = ids[0];
    const before = await prisma.extractionResult.findUnique({
      where: { id: target },
      select: { payloadJson: true },
    });

    const result = await reviewExtractionResultAction({
      id: target,
      reviewStatus: 'edited',
      editedPayload: { lemma: 'user-edited', definition_zh: '用户改过的释义' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reviewStatus).toBe('edited');

    const after = await prisma.extractionResult.findUnique({
      where: { id: target },
      select: { payloadJson: true, editedPayloadJson: true, reviewedAt: true, reviewStatus: true },
    });
    expect(after?.payloadJson).toBe(before?.payloadJson); // 原始输出一字未动
    expect(JSON.parse(after?.editedPayloadJson ?? '{}')).toEqual({
      lemma: 'user-edited',
      definition_zh: '用户改过的释义',
    });
    expect(after?.reviewStatus).toBe('edited');
    expect(after?.reviewedAt).not.toBeNull();
  });

  it('入参校验：edited 必须带 editedPayload，非 edited 不许带', async () => {
    const materialId = await importText('入参校验样本');
    await runToReviewRequired(materialId);
    const ids = await extractionIds(materialId);

    const missing = await reviewExtractionResultAction({
      id: ids[0],
      reviewStatus: 'edited',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('VALIDATION');

    const extra = await reviewExtractionResultAction({
      id: ids[0],
      reviewStatus: 'accepted',
      editedPayload: { lemma: 'x' },
    });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.code).toBe('VALIDATION');

    const unknownField = await reviewExtractionResultAction({
      id: ids[0],
      reviewStatus: 'accepted',
      whatever: true,
    });
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) expect(unknownField.code).toBe('VALIDATION');
  });

  it('分析未结束时不许裁决（PRECONDITION）', async () => {
    const materialId = await importText('未完成样本');
    const result = await reviewExtractionResultAction({
      id: 'cknotexist000000000000',
      reviewStatus: 'accepted',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_FOUND');

    // 材料还在 created/validating：即使 id 存在也应被前置断言拦住
    await tick(materialId);
    const ids = await extractionIds(materialId);
    if (ids.length > 0) {
      const blocked = await reviewExtractionResultAction({
        id: ids[0],
        reviewStatus: 'accepted',
      });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.code).toBe('PRECONDITION');
    }
  });
});

describe('重新生成摘要', () => {
  it('追加新的 SUMMARY（draft），旧草稿摘要降级为 rejected', async () => {
    const materialId = await importText('重生成摘要样本');
    await runToReviewRequired(materialId);

    const before = await getLatestSummary(materialId);
    expect(before).not.toBeNull();

    const result = await regenerateMaterialSummaryAction({ materialId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.keyPoints).toBeGreaterThan(0);
    expect(result.data.extractionId.length).toBeGreaterThan(0);

    const fresh = await getLatestSummary(materialId);
    expect(fresh?.id).toBe(result.data.extractionId);
    expect(fresh?.reviewStatus).toBe('draft');
    expect(typeof fresh?.payload.summary_zh).toBe('string');

    // 旧摘要没有被覆盖：它还在，只是不再排队
    const old = await prisma.extractionResult.findUnique({
      where: { id: before?.id ?? '' },
      select: { reviewStatus: true, payloadJson: true },
    });
    expect(old?.payloadJson).toBe(JSON.stringify(before?.payload ?? {}));
    expect(old?.reviewStatus).toBe('rejected');
  });
});

describe('跳过练习生成', () => {
  it('仍有待审项时只改说法，全部审完后照常 ready', async () => {
    const materialId = await importText('跳过练习样本');
    await runToReviewRequired(materialId);

    const skipped = await skipExerciseGenerationAction({ materialId });
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(skipped.data.materialStatus).toBe('review_required');

    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true, statusReason: true },
    });
    expect(material?.status).toBe('review_required');
    expect(material?.statusReason).toContain('已跳过练习生成');

    const ids = await extractionIds(materialId);
    await bulkReviewExtractionAction({ materialId, ids, reviewStatus: 'accepted' });
    // T12：采纳关键词顺带物化出的词汇候选也要审完，材料才会 ready
    await acceptVocabCandidates(materialId);
    expect(await materialStatusOf(materialId)).toBe('ready');

    // 已经是 ready 之后就不能再"跳过"了
    const again = await skipExerciseGenerationAction({ materialId });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('PRECONDITION');
  });
});

describe('继续分析（新开一次运行 + 跳过已分析 chunk）', () => {
  it('新开 job：attempt +1、四个计数器归零、旧 job 一字未变', async () => {
    const materialId = await importText('续跑新运行样本', multiChunkText('ContinueA'));
    await runToReviewRequired(materialId);

    const oldJob = await latestJob(materialId);
    if (!oldJob) throw new Error('缺少 job');
    const oldSnapshot = {
      status: oldJob.status,
      aiCallCount: oldJob.aiCallCount,
      progressJson: oldJob.progressJson,
      finishedAt: oldJob.finishedAt?.toISOString() ?? null,
    };

    // 造出「还有 1 块没分析」的 partial
    const lastChunkId = await dropLastChunkResults(materialId);
    expect(lastChunkId.length).toBeGreaterThan(0);
    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: {
        status: 'partial',
        statusReason: '已分析前 1/2 个 chunk（达到单次运行 AI 调用上限），可确认继续',
      },
    });

    const continued = await continueAnalysisAction({ materialId });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;

    expect(continued.data.jobId).not.toBe(oldJob.id); // 新 job，不是重开
    expect(continued.data.attempt).toBe(oldJob.attempt + 1);
    expect(continued.data.materialStatus).toBe('analyzing');
    expect(continued.data.analyzedChunks).toBeGreaterThan(0);
    expect(continued.data.remainingChunks).toBeGreaterThan(0);

    const fresh = await prisma.processingJob.findUnique({
      where: { id: continued.data.jobId },
    });
    expect(fresh?.status).toBe('running');
    expect(fresh?.stage).toBe('analyzing');
    expect(fresh?.attempt).toBe(oldJob.attempt + 1);
    expect(fresh?.aiCallCount).toBe(0);
    expect(fresh?.inputTokens).toBe(0);
    expect(fresh?.outputTokens).toBe(0);
    expect(fresh?.estimatedCostUsd).toBe(0);
    expect(fresh?.progressJson).toBeNull();
    expect(fresh?.finishedAt).toBeNull();

    // 旧 job 是历史记录：一个字段都不许改
    const stale = await prisma.processingJob.findUnique({ where: { id: oldJob.id } });
    expect(stale?.status).toBe(oldSnapshot.status);
    expect(stale?.aiCallCount).toBe(oldSnapshot.aiCallCount);
    expect(stale?.progressJson).toBe(oldSnapshot.progressJson);
    expect(stale?.finishedAt?.toISOString() ?? null).toBe(oldSnapshot.finishedAt);

    expect(await materialStatusOf(materialId)).toBe('analyzing');
    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { statusReason: true },
    });
    expect(material?.statusReason).toBeNull();
  });

  it('新一轮跳过已分析的 chunk：同一块不会产生第二条结果', async () => {
    const materialId = await importText('跳过已分析样本', multiChunkText('SkipA'));
    await runToReviewRequired(materialId);

    const chunks = await prisma.contentChunk.findMany({
      where: { materialId },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true },
    });
    if (chunks.length < 2) throw new Error(`用例需要 ≥2 个 chunk，实际 ${chunks.length} 个`);
    // mock 通道只会给"本批第一块"造出可回验的引文，所以拿 seq 最小的那一块做断言：
    // **不跳过的话，它就是下一轮的第一块，会被重新分析并产出一批新行**。
    const analyzedChunkId = chunks[0].id;

    await prisma.extractionResult.deleteMany({
      where: { materialId, chunkId: analyzedChunkId },
    });
    await prisma.extractionResult.create({
      data: {
        materialId,
        chunkId: analyzedChunkId,
        kind: 'KEYWORD',
        payloadJson: JSON.stringify({ lemma: 'preexisting', definition_zh: '已分析过的标记' }),
        sourceQuote: LONG_PARA.slice(0, 40),
        sourceVerified: true,
        isDerived: true,
        reviewStatus: 'accepted',
        reviewedAt: new Date(),
      },
    });

    const beforeAnalyzed = await prisma.extractionResult.count({
      where: { materialId, chunkId: analyzedChunkId },
    });
    expect(beforeAnalyzed).toBe(1);

    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: { status: 'partial', statusReason: '已分析前 1/2 个 chunk，可确认继续' },
    });

    const continued = await continueAnalysisAction({ materialId });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.data.analyzedChunks).toBe(1);
    expect(continued.data.remainingChunks).toBe(chunks.length - 1);

    const result = await tick(materialId);
    expect(result.advanced).toBe(true);

    // ① 关键：已分析过的那一块**一行都没多** —— 说明它没被放进这一轮
    //   （若没跳过，它会是本批第一块，mock 会给它再造一批可回验的结果）
    expect(
      await prisma.extractionResult.count({ where: { materialId, chunkId: analyzedChunkId } }),
    ).toBe(beforeAnalyzed);

    // ② 这一轮确实调了模型（不是"跳过一切"的空转）
    const fresh = await prisma.processingJob.findUnique({
      where: { id: continued.data.jobId },
      select: { aiCallCount: true },
    });
    expect(fresh?.aiCallCount ?? 0).toBeGreaterThan(0);
  });

  it('所有 chunk 都已分析过时，继续分析被拒（PRECONDITION）', async () => {
    const materialId = await importText('无需继续样本');
    await runToReviewRequired(materialId);
    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: { status: 'partial', statusReason: '已分析全部 chunk，但摘要未生成，可确认继续' },
    });

    const result = await continueAnalysisAction({ materialId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(result.error).toContain('所有内容块都已分析过');
    expect(await materialStatusOf(materialId)).toBe('partial');
  });

  it('新一轮的上限按 60 独立生效：新 job 从 0 起，不会被误判触顶', async () => {
    const materialId = await importText('新运行额度样本', multiChunkText('BudgetA'));
    await runToReviewRequired(materialId);

    const oldJob = await latestJob(materialId);
    if (!oldJob) throw new Error('缺少 job');
    // 旧运行顶格（模拟上一轮因额度停下）
    await prisma.processingJob.update({
      where: { id: oldJob.id },
      data: {
        aiCallCount: MATERIAL_LIMITS.maxAiCalls,
        status: 'succeeded',
        finishedAt: new Date(),
      },
    });
    await dropLastChunkResults(materialId);
    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: { status: 'partial', statusReason: '已分析前 1/2 个 chunk，可确认继续' },
    });

    const continued = await continueAnalysisAction({ materialId });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;

    const fresh = await prisma.processingJob.findUnique({
      where: { id: continued.data.jobId },
    });
    expect(fresh?.aiCallCount).toBe(0); // 旧运行的 60 不带过来

    const result = await tick(materialId);
    // 关键：没有被旧运行的 60 次误判成触顶 —— 真的推进了，且没有落 partial
    expect(result.advanced).toBe(true);
    expect(result.status).not.toBe('partial');

    // 本轮真的把活干完了（generating 占位 → review_required）
    let current = result;
    for (let index = 0; index < 4 && current.status !== 'review_required'; index += 1) {
      current = await tick(materialId);
    }
    expect(current.status).toBe('review_required');

    const after = await prisma.processingJob.findUnique({
      where: { id: continued.data.jobId },
    });
    expect(after?.aiCallCount ?? 0).toBeGreaterThan(0);
    expect(after?.aiCallCount ?? 0).toBeLessThanOrEqual(MATERIAL_LIMITS.maxAiCalls);
  });

  it('不是 partial 的材料不能继续分析', async () => {
    const materialId = await importText('非 partial 样本');
    await runToReviewRequired(materialId);

    const result = await continueAnalysisAction({ materialId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(await materialStatusOf(materialId)).toBe('review_required');
  });
});

describe('端到端：材料真的能走到 review_required', () => {
  it('created → … → analyzing → generating → review_required，且不出现 stage_not_registered', async () => {
    const materialId = await importText('端到端链路样本', `${TEXT} Chain.`);

    const trail: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await tick(materialId);
      trail.push(`${result.stage}:${result.status}:${result.reason}`);
      if (
        result.status === 'review_required'
        || result.status === 'failed'
        || result.status === 'cancelled'
      ) {
        break;
      }
    }

    // ① 真实的 generating 必须真的被调用（而不是停在"阶段未注册"）
    expect(trail.some((item) => item.includes('stage_not_registered'))).toBe(false);
    expect(trail.some((item) => item.startsWith('analyzing:'))).toBe(true);
    expect(trail.some((item) => item.startsWith('generating:'))).toBe(true);

    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true, statusReason: true },
    });
    expect(material?.status).toBe('review_required');
    // 还没人采纳过任何分析结果 → 生成器明确说明"没有出题依据"，而不是静默跳过
    expect(material?.statusReason).toBe(GENERATING_NO_ANCHOR_REASON);

    const job = await latestJob(materialId);
    expect(job?.status).toBe('succeeded');
    expect(job?.stage).toBe('generating');

    // ② 到了 review_required 之后，审核 action 的前置才可能通过（不再永远 PRECONDITION）
    const ids = await extractionIds(materialId);
    expect(ids.length).toBeGreaterThan(0);
    const reviewed = await bulkReviewExtractionAction({
      materialId,
      ids,
      reviewStatus: 'accepted',
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    // 采纳之后先停在待审核：T12 起「审完分析结果」还会物化出词汇候选，
    // 而候选同样要人点头（闸门不认"AI 自己觉得没问题"）
    expect(reviewed.data.materialStatus).toBe('review_required');
    await acceptVocabCandidates(materialId);
    expect(await materialStatusOf(materialId)).toBe('ready');
  });
});
