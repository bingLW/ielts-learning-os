/**
 * 练习作答与审核的集成测试（真实 Prisma + 内置 mock provider）。
 *
 * 覆盖 T11 §6 的硬要求：
 * - **作答不产生证据**：`ExerciseAttempt` 落库，`evidenceId` 恒为 null、
 *   `evidenceType` 恒为 `PRACTICE_ONLY`，且**不新增** `EvidenceRecord`（ADR-08）；
 * - **`canEnterPlacement` 随审核状态变化**：draft 时 false、approved 后 true；
 * - **拒绝/退役的题不能作答**（`PRECONDITION`）；
 * - **编辑必须重新自检**：引用写坏 → `PRECONDITION` 且库里一个字段都不许变；
 *   引用合法 → `dedupeKey` 随题干变化重算；
 * - **作答页拿不到答案**：`getExerciseSet(setId, { revealAnswers: false })`
 *   的 `correctKey` / `explanation` 必须为 null。
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
const {
  bulkReviewExercisesAction,
  retireExerciseAction,
  reviewExerciseAction,
  startExerciseGenerationAction,
  submitExerciseAttemptAction,
} = await import('@/lib/actions/materialExercises');
const { getExerciseSet, listExerciseSets } = await import('@/lib/queries/materials');
const { materialsDir } = await import('@/lib/storage');

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

async function settle(materialId: string) {
  let last = await tick(materialId);
  for (let index = 0; index < 12; index += 1) {
    const row = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true },
    });
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

/** 导入 → 分析完 → 采纳全部可出题结果 → 生成练习 → 停在待审核。 */
async function prepareMaterialWithExercises(title: string): Promise<{
  materialId: string;
  setId: string;
  exerciseIds: string[];
}> {
  const materialId = await importText(title);
  await settle(materialId);
  await prisma.extractionResult.updateMany({
    where: {
      materialId,
      kind: { in: ANCHOR_KINDS },
      chunkId: { not: null },
      reviewStatus: 'draft',
    },
    data: { reviewStatus: 'accepted' },
  });

  const started = await startExerciseGenerationAction({ materialId });
  if (!started.ok) throw new Error(`生成练习失败：${started.error}`);
  await settle(materialId);

  const exercises = await prisma.generatedExercise.findMany({
    where: { materialId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, setId: true },
  });
  if (exercises.length === 0) throw new Error(`没有生成任何题目：${title}`);
  return {
    materialId,
    setId: exercises[0].setId,
    exerciseIds: exercises.map((row) => row.id),
  };
}

/** 读出某道题的正确答案（判分断言用）。 */
async function correctKeyOf(exerciseId: string): Promise<string> {
  const row = await prisma.generatedExercise.findUnique({
    where: { id: exerciseId },
    select: { answerJson: true },
  });
  const answer = JSON.parse(row?.answerJson ?? '{}') as { correctKey?: string };
  if (!answer.correctKey) throw new Error('这道题没有正确答案');
  return answer.correctKey;
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

describe('作答：判分、留痕、不产生证据（ADR-08）', () => {
  it('答对写一条 PRACTICE_ONLY 作答，且不新建 EvidenceRecord', async () => {
    const { materialId, setId, exerciseIds } = await prepareMaterialWithExercises('作答样本');
    const exerciseId = exerciseIds[0];
    const correctKey = await correctKeyOf(exerciseId);

    const evidenceBefore = await prisma.evidenceRecord.count();
    const attemptsBefore = await prisma.exerciseAttempt.count({ where: { setId } });

    const result = await submitExerciseAttemptAction({
      exerciseId,
      selectedKey: correctKey,
      elapsedSec: 12,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.isCorrect).toBe(true);
    expect(result.data.correctKey).toBe(correctKey);
    expect(result.data.reviewStatusAtAttempt).toBe('draft');
    // 未审核的题不进正式排程
    expect(result.data.canEnterPlacement).toBe(false);
    expect(result.data.evidenceType).toBe('PRACTICE_ONLY');
    expect(result.data.evidenceQuote.trim().length).toBeGreaterThan(0);

    const attempt = await prisma.exerciseAttempt.findUnique({
      where: { id: result.data.attemptId },
    });
    expect(attempt?.isCorrect).toBe(true);
    expect(attempt?.reviewStatusAtAttempt).toBe('draft');
    expect(attempt?.evidenceType).toBe('PRACTICE_ONLY');
    expect(attempt?.evidenceId).toBeNull();

    const response = JSON.parse(attempt?.responseJson ?? '{}') as {
      selectedKey?: string;
      isCorrect?: boolean;
      elapsedSec?: number;
    };
    expect(response.selectedKey).toBe(correctKey);
    expect(response.isCorrect).toBe(true);
    expect(response.elapsedSec).toBe(12);

    // 关键：材料题作答永不创建证据
    expect(await prisma.evidenceRecord.count()).toBe(evidenceBefore);
    expect(await prisma.exerciseAttempt.count({ where: { setId } })).toBe(attemptsBefore + 1);
    expect(await prisma.exerciseAttempt.count({ where: { materialId, evidenceId: { not: null } } }))
      .toBe(0);
  });

  it('答错也留痕，并给出正确答案与解析', async () => {
    const { exerciseIds } = await prepareMaterialWithExercises('答错样本');
    const exerciseId = exerciseIds[0];
    const correctKey = await correctKeyOf(exerciseId);

    const row = await prisma.generatedExercise.findUnique({
      where: { id: exerciseId },
      select: { answerJson: true },
    });
    const keys = (JSON.parse(row?.answerJson ?? '{}') as {
      options?: Array<{ key: string }>;
    }).options?.map((option) => option.key) ?? [];
    const wrongKey = keys.find((key) => key !== correctKey);
    expect(wrongKey).toBeDefined();

    const result = await submitExerciseAttemptAction({
      exerciseId,
      selectedKey: wrongKey ?? 'Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isCorrect).toBe(false);
    expect(result.data.correctKey).toBe(correctKey);
    expect(result.data.explanation.trim().length).toBeGreaterThan(0);
  });

  it('选项之外的 key 被拒（而不是静默判错）', async () => {
    const { exerciseIds } = await prepareMaterialWithExercises('非法选项样本');
    const before = await prisma.exerciseAttempt.count();

    const result = await submitExerciseAttemptAction({
      exerciseId: exerciseIds[0],
      selectedKey: 'ZZ',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VALIDATION');
    expect(await prisma.exerciseAttempt.count()).toBe(before);
  });

  it('审核通过后 canEnterPlacement 变 true（同一道题前后对比）', async () => {
    const { exerciseIds } = await prepareMaterialWithExercises('排程资格样本');
    const exerciseId = exerciseIds[0];
    const correctKey = await correctKeyOf(exerciseId);

    const before = await submitExerciseAttemptAction({ exerciseId, selectedKey: correctKey });
    expect(before.ok && before.data.canEnterPlacement).toBe(false);

    const approved = await reviewExerciseAction({ exerciseId, reviewStatus: 'approved' });
    expect(approved.ok).toBe(true);

    const after = await submitExerciseAttemptAction({ exerciseId, selectedKey: correctKey });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.canEnterPlacement).toBe(true);
    expect(after.data.reviewStatusAtAttempt).toBe('approved');
    // 证据类型仍然是 PRACTICE_ONLY：资格变了，但"这次作答不是独立证据"不变
    expect(after.data.evidenceType).toBe('PRACTICE_ONLY');
  });

  it('拒绝 / 退役的题不能作答（PRECONDITION）', async () => {
    const { exerciseIds } = await prepareMaterialWithExercises('不可作答样本');
    const correctKey = await correctKeyOf(exerciseIds[0]);

    const rejected = await reviewExerciseAction({
      exerciseId: exerciseIds[0],
      reviewStatus: 'rejected',
    });
    expect(rejected.ok).toBe(true);
    const rejectedAttempt = await submitExerciseAttemptAction({
      exerciseId: exerciseIds[0],
      selectedKey: correctKey,
    });
    expect(rejectedAttempt.ok).toBe(false);
    if (!rejectedAttempt.ok) {
      expect(rejectedAttempt.code).toBe('PRECONDITION');
      expect(rejectedAttempt.error).toContain('拒绝');
    }

    const retired = await retireExerciseAction({
      exerciseId: exerciseIds[1] ?? exerciseIds[0],
      reason: '选项与原文不符',
    });
    expect(retired.ok).toBe(true);
    const retiredAttempt = await submitExerciseAttemptAction({
      exerciseId: exerciseIds[1] ?? exerciseIds[0],
      selectedKey: correctKey,
    });
    expect(retiredAttempt.ok).toBe(false);
    if (!retiredAttempt.ok) expect(retiredAttempt.code).toBe('PRECONDITION');
  });

  it('退役要写原因，且退役后不再进入可作答列表', async () => {
    const { setId, exerciseIds } = await prepareMaterialWithExercises('退役原因样本');

    const tooShort = await retireExerciseAction({ exerciseId: exerciseIds[0], reason: '坏' });
    expect(tooShort.ok).toBe(false);

    const okResult = await retireExerciseAction({
      exerciseId: exerciseIds[0],
      reason: '正确答案与原文依据矛盾',
    });
    expect(okResult.ok).toBe(true);

    const row = await prisma.generatedExercise.findUnique({
      where: { id: exerciseIds[0] },
      select: { reviewStatus: true, retiredAt: true, retireReason: true },
    });
    expect(row?.reviewStatus).toBe('retired');
    expect(row?.retiredAt).not.toBeNull();
    expect(row?.retireReason).toBe('正确答案与原文依据矛盾');

    const detail = await getExerciseSet(setId, { revealAnswers: true });
    expect(detail).not.toBeNull();
    const retiredOne = detail?.exercises.find((item) => item.id === exerciseIds[0]);
    expect(retiredOne?.retiredAt).not.toBeNull();
  });
});

describe('审核动作：编辑必须重新自检', () => {
  it('把原文依据改成段落里找不到的话 → PRECONDITION，且库里一个字段都不变', async () => {
    const { exerciseIds } = await prepareMaterialWithExercises('坏引用样本');
    const exerciseId = exerciseIds[0];
    const before = await prisma.generatedExercise.findUnique({ where: { id: exerciseId } });

    const result = await reviewExerciseAction({
      exerciseId,
      reviewStatus: 'approved',
      edits: { evidenceQuote: 'This sentence does not exist anywhere in the source passage at all' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(result.error).toContain('原文依据');

    const after = await prisma.generatedExercise.findUnique({ where: { id: exerciseId } });
    expect(after?.evidenceQuote).toBe(before?.evidenceQuote);
    expect(after?.dedupeKey).toBe(before?.dedupeKey);
    expect(after?.reviewStatus).toBe(before?.reviewStatus);
  });

  it('结构错误（正确答案不在选项里）→ VALIDATION，不入库', async () => {
    const { exerciseIds } = await prepareMaterialWithExercises('结构错误样本');
    const exerciseId = exerciseIds[0];

    const result = await reviewExerciseAction({
      exerciseId,
      reviewStatus: 'approved',
      edits: { correctKey: 'Z' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VALIDATION');
    expect(result.error).toContain('正确答案');
  });

  it('合法编辑会重算 dedupeKey 与一致性，并保存新题干', async () => {
    const { exerciseIds } = await prepareMaterialWithExercises('合法编辑样本');
    const exerciseId = exerciseIds[0];
    const before = await prisma.generatedExercise.findUnique({ where: { id: exerciseId } });
    expect(before).not.toBeNull();
    if (!before) return;

    const answer = JSON.parse(before.answerJson) as {
      options: Array<{ key: string; text: string }>;
      correctKey: string;
    };
    const correctOption = answer.options.find((option) => option.key === answer.correctKey);
    expect(correctOption).toBeDefined();

    const result = await reviewExerciseAction({
      exerciseId,
      reviewStatus: 'approved',
      edits: {
        prompt: `${before.prompt} （已人工改写题干）`,
        // 让正确答案文本逐字出现在引用里 → 一致性可判 pass
        options: answer.options.map((option) =>
          option.key === answer.correctKey
            ? { ...option, text: before.evidenceQuote.split(/\s+/).slice(0, 3).join(' ') }
            : option,
        ),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rechecked).toBe(true);
    expect(result.data.reviewStatus).toBe('approved');
    expect(result.data.dedupeKey).not.toBe(before.dedupeKey);

    const after = await prisma.generatedExercise.findUnique({ where: { id: exerciseId } });
    expect(after?.prompt).toContain('已人工改写题干');
    expect(after?.dedupeKey).toBe(result.data.dedupeKey);
    expect(after?.reviewStatus).toBe('approved');
    expect(['pass', 'unchecked']).toContain(after?.consistencyCheck ?? '');
  });

  it('批量采纳后练习集 hasApprovedOnly 变 true、题目分布同步更新', async () => {
    const { materialId, setId, exerciseIds } = await prepareMaterialWithExercises('批量采纳样本');

    // 分析结果已经全部采纳，只剩练习题待审 → 全采纳后应能 ready
    const setBefore = await prisma.materialExerciseSet.findUnique({
      where: { id: setId },
      select: { hasApprovedOnly: true },
    });
    expect(setBefore?.hasApprovedOnly).toBe(false);

    const bulk = await bulkReviewExercisesAction({
      materialId,
      ids: exerciseIds,
      reviewStatus: 'approved',
    });
    expect(bulk.ok).toBe(true);
    if (!bulk.ok) return;
    expect(bulk.data.updated).toBe(exerciseIds.length);

    const setAfter = await prisma.materialExerciseSet.findUnique({
      where: { id: setId },
      select: { hasApprovedOnly: true },
    });
    expect(setAfter?.hasApprovedOnly).toBe(true);

    const sets = await listExerciseSets(materialId);
    expect(sets).toHaveLength(1);
    expect(sets[0].hasApprovedOnly).toBe(true);
    expect(sets[0].counts.approved).toBe(exerciseIds.length);
    expect(sets[0].counts.draft).toBe(0);
  });
});

describe('作答页拿不到答案（revealAnswers=false）', () => {
  it('correctKey / explanation 在服务端就被抹成 null', async () => {
    const { setId } = await prepareMaterialWithExercises('不泄露答案样本');

    const hidden = await getExerciseSet(setId, { revealAnswers: false });
    expect(hidden).not.toBeNull();
    expect(hidden?.exercises.length ?? 0).toBeGreaterThan(0);
    for (const exercise of hidden?.exercises ?? []) {
      expect(exercise.correctKey).toBeNull();
      expect(exercise.explanation).toBeNull();
      // 题干/选项/依据照常给出（没它们没法作答）
      expect(exercise.prompt.trim().length).toBeGreaterThan(0);
      expect(exercise.options.length).toBeGreaterThanOrEqual(3);
      expect(exercise.evidenceQuote.trim().length).toBeGreaterThan(0);
    }

    const revealed = await getExerciseSet(setId, { revealAnswers: true });
    expect(revealed?.exercises.every((exercise) => exercise.correctKey !== null)).toBe(true);
  });
});
