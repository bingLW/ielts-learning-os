/**
 * 练习生成阶段集成测试（真实 Prisma + 内置 mock provider）。
 *
 * 覆盖 T11 §5 的硬要求：
 * - **依据来源**：只有 `reviewStatus ∈ {accepted, edited}` 且种别可出题的抽取结果
 *   才参与出题；一条都没有时**不是失败**，而是带着原因回到 `review_required`；
 * - **字段完整**：落库的每道题都有 D-04 全字段（题干/答案/解析/依据/定位/溯源）；
 * - **依据可回验**：`evidenceQuote` 必须能在所属 chunk 里逐字找到；
 * - **去重 + 续跑**：`dedupeKey` 唯一，再次触发生成不会重复出题（`existingChunkIds`）；
 * - **全批失败**：本轮所有批次都失败时才落 `failed`。
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import type { MaterialFormat, MaterialSourceType } from '@/lib/constants';

process.env.AI_CREDENTIALS_SECRET ??= 'ielts-integration-test-secret';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const { prisma, cleanup } = await createTestDb();

const { finalizeMaterialUpload } = await import('@/lib/materials/upload');
const { runPipelineTick } = await import('@/lib/materials/pipeline');
const { generatingStage, buildGeneratingStatusReason, GENERATING_NO_ANCHOR_REASON } = await import(
  '@/lib/materials/pipeline/stages/generating'
);
const { ensurePromptRegistry } = await import('@/lib/ai/registry');
const { startExerciseGenerationAction } = await import('@/lib/actions/materialExercises');
const { estimateExerciseSetMinutes, EXERCISE_DEDUPE_KEY_LENGTH } = await import(
  '@/lib/materials/exerciseCheck'
);
const { verifySourceQuote } = await import('@/lib/materials/sourceVerify');
const { MATERIAL_LIMITS } = await import('@/lib/constants');
const { AI_PROMPT_KEY_BY_KIND } = await import('@/lib/ai/types');
const { materialsDir } = await import('@/lib/storage');

/** 可以出题的四类分析结果（与 `EXERCISE_ANCHOR_KINDS` 一致）。 */
const ANCHOR_KINDS = ['KEYWORD', 'COLLOCATION', 'KEY_SENTENCE', 'PARAGRAPH_GIST'];

const TEXT =
  'Reading is a skill that improves with deliberate practice. '
  + 'It also depends on how much vocabulary you already control. '
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

/** 每个样本正文互不相同，避免命中 contentHash 去重而互相污染。 */
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

async function readStatus(materialId: string) {
  const row = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { status: true, statusReason: true },
  });
  return row;
}

/** 连续 tick 直到停在 `review_required` 或终态（最多 12 次）。 */
async function settle(materialId: string) {
  let last = await tick(materialId);
  for (let index = 0; index < 12; index += 1) {
    const row = await readStatus(materialId);
    const status = row?.status;
    if (
      status === 'review_required'
      || status === 'partial'
      || status === 'failed'
      || status === 'cancelled'
    ) {
      break;
    }
    last = await tick(materialId);
  }
  return last;
}

/** 把可出题的四类分析结果全部标记为「已采纳」。 */
async function acceptAnchors(materialId: string): Promise<number> {
  const result = await prisma.extractionResult.updateMany({
    where: {
      materialId,
      kind: { in: ANCHOR_KINDS },
      chunkId: { not: null },
      reviewStatus: 'draft',
    },
    data: { reviewStatus: 'accepted' },
  });
  return result.count;
}

beforeAll(async () => {
  await ensurePromptRegistry(prisma);
  await prisma.aIEngineSetting.create({ data: { id: 'default', externalAiEnabled: false } });
  // 强制 mock 通道：绝不让集成测试打到真实模型
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

describe('没有已采纳结果：不失败，停在待审核并说明原因', () => {
  it('阶段处理器返回 review_required + 明确原因，且不创建练习集、不调模型', async () => {
    const materialId = await importText('无依据样本');
    await settle(materialId);

    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { id: true, title: true, format: true, language: true, sourceType: true },
    });
    const job = await prisma.processingJob.findFirst({
      where: { materialId },
      orderBy: { startedAt: 'desc' },
    });
    expect(material).not.toBeNull();
    expect(job).not.toBeNull();
    if (!material || !job) return;

    const outcome = await generatingStage({
      material: {
        id: material.id,
        title: material.title,
        format: material.format as MaterialFormat,
        status: 'review_required',
        language: material.language,
        sourceType: material.sourceType as MaterialSourceType,
      },
      job: {
        id: job.id,
        attempt: job.attempt,
        stage: 'generating',
        status: job.status,
        lockVersion: job.lockVersion,
        cancelRequested: false,
        aiCallCount: job.aiCallCount,
        inputTokens: job.inputTokens,
        outputTokens: job.outputTokens,
        estimatedCostUsd: job.estimatedCostUsd,
        progress: { done: 0, total: 1, unitLabel: '项' },
        msByStage: {},
      },
      deadline: Date.now() + MATERIAL_LIMITS.tickBudgetMs,
      isCancelled: async () => false,
    });

    expect(outcome.to).toBe('review_required');
    expect(outcome.stage).toBe('generating');
    expect(outcome.statusReason).toBe(GENERATING_NO_ANCHOR_REASON);
    expect(outcome.jobStatus).toBe('succeeded');
    // 没有依据时一次模型都不该调
    expect(outcome.aiUsage?.calls ?? 0).toBe(0);
    // 也不该凭空建练习集
    expect(await prisma.materialExerciseSet.count({ where: { materialId } })).toBe(0);
  });

  it('action 层直接拦下（不让用户白跑一轮）', async () => {
    const materialId = await importText('无依据 action 样本');
    await settle(materialId);

    const result = await startExerciseGenerationAction({ materialId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(result.error).toContain('依据');

    // 材料状态没被改动
    const row = await readStatus(materialId);
    expect(row?.status).toBe('review_required');
  });
});

describe('从已采纳结果生成题目', () => {
  it('落库题目字段完整、依据可回验、去重键唯一、练习集派生字段正确', async () => {
    const materialId = await importText('出题样本');
    await settle(materialId);

    const accepted = await acceptAnchors(materialId);
    expect(accepted).toBeGreaterThan(0);

    const started = await startExerciseGenerationAction({ materialId });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.materialStatus).toBe('generating');
    expect(started.data.acceptedAnchors).toBeGreaterThan(0);

    const afterStart = await readStatus(materialId);
    expect(afterStart?.status).toBe('generating');

    await settle(materialId);

    const material = await readStatus(materialId);
    expect(material?.status).toBe('review_required');
    expect(material?.statusReason).toContain('已生成');

    // ① 一材料一练习集
    const sets = await prisma.materialExerciseSet.findMany({ where: { materialId } });
    expect(sets).toHaveLength(1);
    const set = sets[0];
    expect(set.isActive).toBe(true);

    // ② 题目字段（D-04 全字段）
    const exercises = await prisma.generatedExercise.findMany({
      where: { materialId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(exercises.length).toBeGreaterThan(0);
    expect(exercises.length).toBeLessThanOrEqual(MATERIAL_LIMITS.maxExercises);

    const chunkIds = [...new Set(exercises.map((row) => row.chunkId))];
    const chunks = await prisma.contentChunk.findMany({
      where: { id: { in: chunkIds } },
      select: { id: true, text: true },
    });
    const chunkTextById = new Map(chunks.map((chunk) => [chunk.id, chunk.text]));

    for (const row of exercises) {
      expect(row.setId).toBe(set.id);
      expect(row.isAiGenerated).toBe(true);
      expect(row.reviewStatus).toBe('draft');
      expect(row.prompt.trim().length).toBeGreaterThan(0);
      expect(row.explanation.trim().length).toBeGreaterThan(0);
      expect(row.evidenceQuote.trim().length).toBeGreaterThan(0);
      expect(row.answerJson.length).toBeGreaterThan(0);
      expect(['pass', 'unchecked']).toContain(row.consistencyCheck);
      expect(row.dedupeKey).toHaveLength(EXERCISE_DEDUPE_KEY_LENGTH);
      // 溯源（费用归属 + 审计）
      expect(row.model).toBe('mock');
      expect(row.promptVersionId).not.toBeNull();
      expect(row.aiCallLogId).not.toBeNull();
      // 依据必须能在所属段落里逐字找到（AC-03）
      const chunkText = chunkTextById.get(row.chunkId);
      expect(chunkText).toBeDefined();
      expect(verifySourceQuote(row.evidenceQuote, chunkText ?? '').verified).toBe(true);

      // 答案负载结构（作答判分靠它）
      const answer = JSON.parse(row.answerJson) as {
        options: Array<{ key: string; text: string }>;
        correctKey: string;
        isSingleAnswer: boolean;
      };
      expect(answer.isSingleAnswer).toBe(true);
      expect(answer.options.length).toBeGreaterThanOrEqual(3);
      expect(answer.options.length).toBeLessThanOrEqual(4);
      expect(answer.options.map((option) => option.key)).toContain(answer.correctKey);
    }

    // ③ 去重键唯一（单材料内）
    const keys = exercises.map((row) => row.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);

    // ④ 练习集派生字段
    const ordering = JSON.parse(set.orderingJson ?? '[]') as string[];
    expect(ordering).toHaveLength(exercises.length);
    expect(new Set(ordering).size).toBe(ordering.length);
    expect(set.estimatedMinutes).toBe(estimateExerciseSetMinutes(exercises.length));
    // 全是草稿 → 不是"全绿"
    expect(set.hasApprovedOnly).toBe(false);

    // ⑤ 用量计入（job + 材料累计）
    const job = await prisma.processingJob.findFirst({
      where: { materialId },
      orderBy: { startedAt: 'desc' },
    });
    expect(job?.aiCallCount ?? 0).toBeGreaterThan(0);
    const usage = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { aiCallCount: true },
    });
    expect(usage?.aiCallCount ?? 0).toBeGreaterThan(0);
  });

  it('再次触发生成不会重复出题（existingChunkIds 续跑判据）', async () => {
    const materialId = await importText('续跑去重样本');
    await settle(materialId);
    await acceptAnchors(materialId);

    const first = await startExerciseGenerationAction({ materialId });
    expect(first.ok).toBe(true);
    await settle(materialId);

    const before = await prisma.generatedExercise.count({ where: { materialId } });
    expect(before).toBeGreaterThan(0);

    const second = await startExerciseGenerationAction({ materialId });
    expect(second.ok).toBe(true);
    await settle(materialId);

    const after = await prisma.generatedExercise.count({ where: { materialId } });
    expect(after).toBe(before);

    // 说明这次一轮下来没产出新题（已覆盖的 chunk 不再花钱）
    const material = await readStatus(materialId);
    expect(material?.statusReason).toContain('已生成 0 道练习题');
    // T12 §7.1：「已生成 0 道」必须紧跟跳过原因，不能只留一个自相矛盾的数字
    expect(material?.statusReason).toContain('段原文此前已出过题，本轮跳过');
    // 进度里也要有跳过数：`批次 N / N` 配「0 道」时，这个数是唯一能解释清楚的东西
    const job = await prisma.processingJob.findFirst({
      where: { materialId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { progressJson: true },
    });
    const progress = JSON.parse(job?.progressJson ?? '{}') as { skipped?: number };
    expect(progress.skipped).toBeGreaterThan(0);
    // 仍然只有一个练习集
    expect(await prisma.materialExerciseSet.count({ where: { materialId } })).toBe(1);
  });
});

describe('全批失败才落 failed', () => {
  it('出题提示词不可用时整轮失败，并给出可读原因', async () => {
    const materialId = await importText('出题失败样本');
    await settle(materialId);
    await acceptAnchors(materialId);

    const started = await startExerciseGenerationAction({ materialId });
    expect(started.ok).toBe(true);

    // 制造"出题提示词没有已发布版本"（真实会发生的配置错误）
    const promptKey = AI_PROMPT_KEY_BY_KIND.material_exercise;
    const template = await prisma.promptTemplate.findUnique({ where: { promptKey } });
    expect(template).not.toBeNull();
    if (!template) return;
    await prisma.promptVersion.updateMany({
      where: { templateId: template.id },
      data: { status: 'DRAFT' },
    });

    try {
      await settle(materialId);
      const material = await readStatus(materialId);
      expect(material?.status).toBe('failed');
      expect(material?.statusReason ?? '').toMatch(/练习生成失败/);

      const job = await prisma.processingJob.findFirst({
        where: { materialId },
        orderBy: { startedAt: 'desc' },
        select: { status: true, errorCode: true },
      });
      expect(job?.status).toBe('failed');
      // 契约：错误码只允许来自固定映射表
      expect(['SCHEMA_VALIDATION', 'INTERNAL_STORAGE', 'PARSE_TIMEOUT', 'BUDGET_EXCEEDED']).toContain(
        job?.errorCode ?? '',
      );
      // 失败时不该留下半截题目
      expect(await prisma.generatedExercise.count({ where: { materialId } })).toBe(0);
    } finally {
      await prisma.promptVersion.updateMany({
        where: { templateId: template.id },
        data: { status: 'PUBLISHED' },
      });
    }
  });
});

// ═════════════════════ T12 §7.2：收尾文案必须分项可观测 ═════════════════════

describe('收尾文案：四种"没进库"的原因各自可见', () => {
  const base = {
    created: 0,
    dropped: 0,
    duplicates: 0,
    missingChunk: 0,
    skippedChunks: 0,
    limitReached: false,
    budgetHit: false,
  };

  it('有产出：只报产出数，不啰嗦', () => {
    expect(buildGeneratingStatusReason({ ...base, created: 12 })).toBe('已生成 12 道练习题');
  });

  it('产出为 0 且有段落被跳过 → 必须紧跟跳过原因（不许自相矛盾）', () => {
    const reason = buildGeneratingStatusReason({ ...base, skippedChunks: 4 });
    expect(reason).toContain('已生成 0 道练习题');
    expect(reason).toContain('4 段原文此前已出过题，本轮跳过');
    expect(reason).toContain('没有重复计费');
  });

  it('依据不可核验 / 重复 / 来源块缺失 分别成句（不合并成一个数字）', () => {
    const reason = buildGeneratingStatusReason({
      ...base,
      created: 12,
      dropped: 4,
      duplicates: 2,
      missingChunk: 1,
    });
    expect(reason).toBe(
      '已生成 12 道练习题；4 道依据无法核验或格式不合规，已丢弃；'
      + '2 道与前题重复，已跳过；1 道标注的来源块不存在，已丢弃',
    );
  });

  it('上限 / 额度命中各自成句', () => {
    const limit = buildGeneratingStatusReason({ ...base, created: 60, limitReached: true });
    expect(limit).toContain(`已达单材料 ${MATERIAL_LIMITS.maxExercises} 道的上限`);
    const budget = buildGeneratingStatusReason({ ...base, created: 8, budgetHit: true });
    expect(budget).toContain('AI 调用已达上限');
  });

  it('什么都不特殊时不出现任何"0 条"噪音', () => {
    const reason = buildGeneratingStatusReason({ ...base });
    expect(reason).toBe('已生成 0 道练习题');
    expect(reason).not.toContain('丢弃');
    expect(reason).not.toContain('重复');
  });
});
