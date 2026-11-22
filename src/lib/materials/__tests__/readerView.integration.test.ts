/**
 * Reader 视图集成测试（真实 Prisma + 内置 mock provider）。
 *
 * 核心是一条**哨兵断言**（AC-03 / C-11 的结构性证据）：
 * 往库里塞一条带 `ZZAISENTINEL001` 的 KEYWORD（draft），然后断言
 * `JSON.stringify(await getReaderView(id, 'original'))` **完全不含**这个哨兵。
 *
 * 这不是"UI 恰好没渲染"的运气，而是查询层的结构保证：`getReaderView` 在
 * 查 `ExtractionResult` / `VocabularyCandidate` **之前**就 return 了原文模式。
 * 反向断言同样重要（否则"什么都不显示"也能让测试变绿）：
 * - `vocab_assist` 必须真的把**已采纳**的词条变成 hint；
 * - `draft` 的词条**不能**出现在 hint 里；
 * - 每条 hint 的 `[start, end)` 必须真的落在原文里、且切出来的就是该词形。
 */

import { copyFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sourceDb = join(process.cwd(), 'prisma', 'dev.db');
const workDb = join(tmpdir(), `ielts-reader-${process.pid}-${Date.now()}.db`);

if (!existsSync(sourceDb)) throw new Error(`找不到数据库：${sourceDb}`);
copyFileSync(sourceDb, workDb);
// 单连接 + 内存日志：本机安全删除钩子对 unlink 敏感，见 pipeline.integration.test.ts
process.env.DATABASE_URL = `file:${workDb}?connection_limit=1`;
process.env.AI_CREDENTIALS_SECRET ??= 'ielts-integration-test-secret';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const { prisma } = await import('@/lib/prisma');
await prisma.$queryRawUnsafe('PRAGMA journal_mode = MEMORY');

const { finalizeMaterialUpload } = await import('@/lib/materials/upload');
const { runPipelineTick } = await import('@/lib/materials/pipeline');
const { ensurePromptRegistry } = await import('@/lib/ai/registry');
const {
  getReaderView,
  listChunkToc,
  listExtractionResults,
  getMaterialSource,
} = await import('@/lib/queries/materials');
const { materialsDir } = await import('@/lib/storage');

/** 哨兵字符串：只要它出现在"原文视图"里，就说明有 AI 文本泄漏。 */
const SENTINEL = 'ZZAISENTINEL001';

const READER_TEXT =
  'Reading is a skill that improves with deliberate practice. '
  + 'Vocabulary breadth predicts comprehension more strongly than grammar knowledge.';

/** 真实词形（已采纳的那条 KEYWORD 用它，必须能在原文里定位到）。 */
const REAL_LEMMA = 'Reading';

const createdIds = new Set<string>();

function pasteForm(
  title: string,
  text: string,
  sourceType = 'user_upload',
): FormData {
  const formData = new FormData();
  formData.set(
    'meta',
    JSON.stringify({
      title,
      pastedText: text,
      source: { sourceType, rightsConfirmed: true },
    }),
  );
  return formData;
}

async function importText(
  title: string,
  text: string,
  sourceType = 'user_upload',
): Promise<string> {
  const result = await finalizeMaterialUpload(pasteForm(title, text, sourceType));
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

/** 连续 tick 直到材料进入待审核（analysis 完成、停在 generating 之前）。 */
async function runToReviewRequired(materialId: string): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    const status = (
      await prisma.learningMaterial.findUnique({
        where: { id: materialId },
        select: { status: true },
      })
    )?.status;
    if (status === 'review_required' || status === 'failed' || status === 'partial') return;
    await tick(materialId);
  }
}

beforeAll(async () => {
  await ensurePromptRegistry(prisma);
  // 强制 mock 通道：绝不打到真实模型
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
      (async () => {
        try {
          await rm(workDb, { force: true });
        } catch {
          // 忽略
        }
      })(),
    ]);
  }
  await prisma.$disconnect();
}, 60_000);

describe('原文模式绝不出现 AI 文本（AC-03 / C-11）', () => {
  it('库里存在带哨兵的 AI 结果，但原文视图的序列化结果里找不到它', async () => {
    const materialId = await importText('Reader 哨兵样本', READER_TEXT);
    await runToReviewRequired(materialId);

    const chunk = await prisma.contentChunk.findFirst({
      where: { materialId },
      orderBy: { seq: 'asc' },
      select: { id: true, text: true, seq: true },
    });
    expect(chunk).not.toBeNull();
    if (!chunk) return;

    // ① 塞一条 draft 的 KEYWORD：payloadJson 与 sourceQuote 里都写哨兵
    await prisma.extractionResult.create({
      data: {
        materialId,
        chunkId: chunk.id,
        kind: 'KEYWORD',
        payloadJson: JSON.stringify({
          kind: 'KEYWORD',
          source_chunk_seq: chunk.seq,
          source_quote: chunk.text.slice(0, 30),
          lemma: SENTINEL,
          pos: 'noun',
          definition_zh: '哨兵释义',
        }),
        sourceQuote: `${SENTINEL} reading sentence used as a sentinel`,
        sourceVerified: true,
        isDerived: true,
        reviewStatus: 'draft',
      },
    });

    // ② 再塞一条 accepted 的 KEYWORD：真实词形，用来做反向断言
    await prisma.extractionResult.create({
      data: {
        materialId,
        chunkId: chunk.id,
        kind: 'KEYWORD',
        payloadJson: JSON.stringify({
          kind: 'KEYWORD',
          source_chunk_seq: chunk.seq,
          source_quote: 'Reading is a skill that improves',
          lemma: REAL_LEMMA,
          pos: 'noun',
          definition_zh: '阅读',
        }),
        sourceQuote: 'Reading is a skill that improves',
        sourceVerified: true,
        isDerived: true,
        reviewStatus: 'accepted',
      },
    });

    // 先证明哨兵确实在库里（否则下面的断言是空转）
    const rows = await prisma.extractionResult.findMany({ where: { materialId } });
    expect(JSON.stringify(rows)).toContain(SENTINEL);

    // ③ 主断言：原文视图的**完整序列化结果**不含哨兵
    const original = await getReaderView(materialId, 'original');
    expect(original).not.toBeNull();
    if (!original) return;

    expect(original.mode).toBe('original');
    expect(JSON.stringify(original)).not.toContain(SENTINEL);

    // 原文视图的 hint 恒为空（结构保证：查询层根本没读 AI 表）
    expect(original.chunks.every((item) => item.hints.length === 0)).toBe(true);

    // 原文逐字渲染：不 trim、不合并空白
    const target = original.chunks.find((item) => item.id === chunk.id);
    expect(target?.text).toBe(chunk.text);

    // ④ 词汇辅助模式反向断言：accepted 的能出来，draft 的出不来
    const assist = await getReaderView(materialId, 'vocab_assist');
    expect(assist).not.toBeNull();
    if (!assist) return;

    expect(assist.mode).toBe('vocab_assist');
    expect(JSON.stringify(assist)).not.toContain(SENTINEL);

    const hints = assist.chunks.flatMap((item) => item.hints);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((hint) => hint.lemma === REAL_LEMMA)).toBe(true);
    expect(hints.every((hint) => hint.source === 'ai')).toBe(true);

    // ⑤ hint 的区间必须真的落在原文里，且切出来就是该词形
    for (const item of assist.chunks) {
      for (const hint of item.hints) {
        expect(item.text.slice(hint.start, hint.end).toLowerCase()).toBe(hint.lemma.toLowerCase());
        expect(hint.start).toBeGreaterThanOrEqual(0);
        expect(hint.end).toBeLessThanOrEqual(item.text.length);
      }
      // hint 之间不重叠（渲染层按"跳过重叠"切片，查询层的排序要能保证这点）
      const sorted = [...item.hints].sort((left, right) => left.start - right.start);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index].start).toBeGreaterThanOrEqual(sorted[index - 1].end);
      }
    }
  });

  it('编辑后的词条以 editedPayload 为准，AI 原始 payload 不被覆盖', async () => {
    const materialId = await importText('Reader 编辑样本', `${READER_TEXT} Edit me.`);
    await runToReviewRequired(materialId);

    const chunk = await prisma.contentChunk.findFirst({
      where: { materialId },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true, text: true },
    });
    if (!chunk) throw new Error('缺少 chunk');

    const created = await prisma.extractionResult.create({
      data: {
        materialId,
        chunkId: chunk.id,
        kind: 'KEYWORD',
        payloadJson: JSON.stringify({
          lemma: 'practice',
          pos: 'noun',
          definition_zh: 'AI 原始释义',
        }),
        sourceQuote: 'Reading is a skill that improves with deliberate practice',
        sourceVerified: true,
        isDerived: true,
        reviewStatus: 'edited',
        editedPayloadJson: JSON.stringify({
          lemma: 'practice',
          pos: 'noun',
          definition_zh: '用户改过的释义',
        }),
        reviewedAt: new Date(),
      },
      select: { id: true },
    });

    const assist = await getReaderView(materialId, 'vocab_assist');
    const hint = assist?.chunks
      .flatMap((item) => item.hints)
      .find((item) => item.lemma === 'practice');
    expect(hint?.definitionZh).toBe('用户改过的释义');

    // 原始负载仍然一字未动（可追溯）
    const row = await prisma.extractionResult.findUnique({
      where: { id: created.id },
      select: { payloadJson: true, editedPayloadJson: true },
    });
    expect(JSON.parse(row?.payloadJson ?? '{}').definition_zh).toBe('AI 原始释义');
    expect(JSON.parse(row?.editedPayloadJson ?? '{}').definition_zh).toBe('用户改过的释义');
  });
});

describe('辅助查询的健壮性', () => {
  it('listExtractionResults 遇到脏 payloadJson 退化为 {}，不抛错', async () => {
    const materialId = await importText('脏数据样本', `${READER_TEXT} Dirty row.`);

    const chunk = await prisma.contentChunk.findFirst({
      where: { materialId },
      orderBy: { seq: 'asc' },
      select: { id: true },
    });

    // 直接写坏 JSON（真实场景：迁移/手改/旧版本格式）
    await prisma.extractionResult.create({
      data: {
        materialId,
        chunkId: chunk?.id ?? null,
        kind: 'KEYWORD',
        payloadJson: '{not-json',
        sourceQuote: 'Reading is a skill that improves',
        sourceVerified: true,
        isDerived: true,
        reviewStatus: 'draft',
      },
    });

    const cards = await listExtractionResults(materialId);
    expect(cards.length).toBe(1);
    expect(cards[0].payload).toEqual({});
    expect(cards[0].reviewStatus).toBe('draft');
    expect(cards[0].isDerived).toBe(true);
  });

  it('listChunkToc 只返回有标题路径的 chunk（无标题时为空数组）', async () => {
    const materialId = await importText('目录样本', `${READER_TEXT} Toc.`);
    const toc = await listChunkToc(materialId);
    expect(Array.isArray(toc)).toBe(true);
    for (const item of toc) {
      expect(item.headingPath.trim().length).toBeGreaterThan(0);
      expect(item.chunkId.length).toBeGreaterThan(0);
    }
  });

  it('getMaterialSource：unknown / licensed_subscription 禁止导出', async () => {
    const restrictedId = await importText('受限来源样本', `${READER_TEXT} Restricted.`, 'unknown');
    const restricted = await getMaterialSource(restrictedId);
    expect(restricted?.sourceType).toBe('unknown');
    expect(restricted?.restrictedExport).toBe(true);

    const openId = await importText('开放来源样本', `${READER_TEXT} Open.`, 'public_domain');
    const open = await getMaterialSource(openId);
    expect(open?.restrictedExport).toBe(false);
  });
});
