'use server';

/**
 * 材料练习的五个 Server Action（T11）：生成 → 审核 → 批量 → 退役 → 作答。
 *
 * 统一约定与 `actions/materialAnalysis.ts` 一致：`safeParse` 失败走 `failValidation`、
 * 失败**返回**不 throw、写库后 `revalidatePath`。
 *
 * 这一层只做四件事 —— ① 前置断言；② 调纯函数拿结论（`checkExerciseDraft` /
 * `decideExerciseUse`）；③ 一次写库；④ 结算材料状态。它**不自己判断**
 * "题目能不能用"（`domain/materialExerciseGate` 是唯一裁决点）、
 * "材料该不该 ready"（`services/materialReviewSettle` 是唯一落库点）。
 */

import { revalidatePath } from 'next/cache';
import {
  MATERIAL_LIMITS,
  type MaterialAttemptEvidenceType,
  type MaterialConsistencyStatus,
  type MaterialExerciseReviewStatus,
  type MaterialStatus,
} from '@/lib/constants';
import { decideExerciseUse } from '@/lib/domain/materialExerciseGate';
import { parseJson, stringify } from '@/lib/json';
import { canTransition } from '@/lib/materials/stateMachine';
import {
  checkExerciseDraft,
  estimateExerciseSetMinutes,
  EXERCISE_ANCHOR_KINDS,
  EXERCISE_ANCHOR_REVIEW_STATUSES,
  hasQuoteFailure,
  type ExerciseOptionDraft,
} from '@/lib/materials/exerciseCheck';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import {
  exerciseAttemptSchema,
  exerciseBulkReviewSchema,
  exerciseGenerationStartSchema,
  exerciseRetireSchema,
  exerciseReviewSchema,
} from '@/lib/schema/materialExercise';
import { settleMaterialReviewStatus } from '@/lib/services/materialReviewSettle';
import type { ActionResult } from '@/lib/types';

/** 允许裁决练习的材料状态（`partial` 也算：材料已定稿但练习仍可维护）。 */
const REVIEWABLE_MATERIAL_STATUSES: readonly MaterialStatus[] = [
  'review_required',
  'ready',
  'partial',
];

/**
 * 允许作答的材料状态。
 *
 * 处理中（`created`…`generating`）不允许作答：题目还在长出来，此时作答等于
 * 对着半成品记录"我做过"。`failed` / `cancelled` 也不允许 —— 那份材料没有可用内容。
 */
const PRACTICABLE_MATERIAL_STATUSES: readonly MaterialStatus[] = [
  'review_required',
  'ready',
  'partial',
];

/** 审核页 / 练习页 / 材料库共用的失效路径。 */
function revalidateExercisePaths(materialId: string): void {
  revalidatePath(`/materials/${materialId}/exercises`);
  revalidatePath(`/materials/${materialId}/analysis`);
  revalidatePath('/materials');
}

/** 读材料状态（不存在返回 null）。 */
async function readMaterialStatus(materialId: string): Promise<MaterialStatus | null> {
  const row = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { status: true },
  });
  return row ? (row.status as MaterialStatus) : null;
}

/** `answerJson` 的安全解析（脏数据退化为空，不抛错）。 */
function readAnswer(answerJson: string): {
  options: ExerciseOptionDraft[];
  correctKey: string;
} {
  const parsed = parseJson<{ options?: unknown; correctKey?: unknown }>(answerJson, {}) ?? {};
  const raw = Array.isArray(parsed.options) ? parsed.options : [];
  const options: ExerciseOptionDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { key?: unknown; text?: unknown };
    if (typeof record.key !== 'string' || typeof record.text !== 'string') continue;
    options.push({ key: record.key, text: record.text });
  }
  return {
    options,
    correctKey: typeof parsed.correctKey === 'string' ? parsed.correctKey : '',
  };
}

/**
 * 按当前题目重新计算练习集的派生字段。
 *
 * 三个字段必须**每次裁决后**重算，否则会出现「全部都采纳了，但 `hasApprovedOnly`
 * 还是 false」「退役 10 道题，时长仍是 40 分钟」这种自相矛盾的展示。
 *
 * @param setId 练习集 id
 */
async function recomputeSetFlags(setId: string): Promise<void> {
  const live = await prisma.generatedExercise.findMany({
    where: { setId, retiredAt: null },
    select: { reviewStatus: true },
  });

  const hasApprovedOnly =
    live.length > 0 && live.every((row) => row.reviewStatus === 'approved');

  await prisma.materialExerciseSet.update({
    where: { id: setId },
    data: {
      hasApprovedOnly,
      estimatedMinutes: estimateExerciseSetMinutes(live.length),
    },
  });
}

// ───────────────────────── ① 开始生成练习 ─────────────────────────

export interface StartExerciseGenerationData {
  /** 新一轮运行的 job id（tick 会从这个 job 继续跑）。 */
  jobId: string;
  attempt: number;
  materialStatus: MaterialStatus;
  /** 参与出题的分析结果条数（= 出题依据规模）。 */
  acceptedAnchors: number;
  /** 已有题目数（再次生成时会被跳过，不会重复花钱）。 */
  existingExercises: number;
}

/**
 * 开始一次练习生成运行（`review_required → generating`）。
 *
 * 前置断言：
 * 1. 材料存在；
 * 2. 材料处于 `review_required`（分析已完成、等你裁决）；
 * 3. 状态机允许 `review_required → generating`（这条边是 T11 新增的）；
 * 4. 至少有一条**已采纳**的可出题分析结果 —— 否则跑一轮只会得到一句
 *    "没有依据"，不如直接在按钮上告诉用户先去审核。
 *
 * @param raw `{ materialId }`
 */
export async function startExerciseGenerationAction(
  raw: unknown,
): Promise<ActionResult<StartExerciseGenerationData>> {
  const parsed = exerciseGenerationStartSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const materialId = parsed.data.materialId;
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true, status: true },
  });
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');

  const status = material.status as MaterialStatus;
  if (status !== 'review_required') {
    return fail(
      'PRECONDITION',
      status === 'generating'
        ? '练习正在生成中，请稍候（进度见处理页）'
        : '只有「待你审核」的材料可以生成练习（请先等 AI 分析完成）',
    );
  }
  if (!canTransition('review_required', 'generating')) {
    return fail('PRECONDITION', '当前状态不允许生成练习');
  }

  const [acceptedAnchors, pendingExtractions, existingExercises] = await Promise.all([
    prisma.extractionResult.count({
      where: {
        materialId,
        kind: { in: [...EXERCISE_ANCHOR_KINDS] },
        reviewStatus: { in: [...EXERCISE_ANCHOR_REVIEW_STATUSES] },
        chunkId: { not: null },
      },
    }),
    prisma.extractionResult.count({ where: { materialId, reviewStatus: 'draft' } }),
    prisma.generatedExercise.count({ where: { materialId, retiredAt: null } }),
  ]);

  if (acceptedAnchors === 0) {
    return fail(
      'PRECONDITION',
      pendingExtractions > 0
        ? `还有 ${pendingExtractions} 条分析结果没裁决：先在「AI 分析」页采纳至少一条，才有出题依据`
        : '没有可出题的分析结果：请回到处理页确认分析是否已完成',
    );
  }
  if (existingExercises >= MATERIAL_LIMITS.maxExercises) {
    return fail(
      'PRECONDITION',
      `这份材料已有 ${existingExercises} 道题（上限 ${MATERIAL_LIMITS.maxExercises} 道），请先退役一些再生成`,
    );
  }

  const lastJob = await prisma.processingJob.findFirst({
    where: { materialId },
    orderBy: { attempt: 'desc' },
    select: { attempt: true },
  });
  const attempt = (lastJob?.attempt ?? 0) + 1;

  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.processingJob.create({
      data: {
        materialId,
        stage: 'generating',
        status: 'running',
        attempt,
        cancelRequested: false,
        aiCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        progressJson: null,
        startedAt: new Date(),
      },
      select: { id: true },
    });

    await tx.learningMaterial.update({
      where: { id: materialId },
      data: { status: 'generating', statusReason: null },
    });

    return created;
  });

  revalidateExercisePaths(materialId);
  revalidatePath(`/materials/${materialId}/processing`);

  return ok<StartExerciseGenerationData>({
    jobId: job.id,
    attempt,
    materialStatus: 'generating',
    acceptedAnchors,
    existingExercises,
  });
}

// ───────────────────────── ② 单条裁决（含编辑） ─────────────────────────

export interface ReviewExerciseData {
  exerciseId: string;
  reviewStatus: MaterialExerciseReviewStatus;
  /** 是否因为编辑而重新跑过自检。 */
  rechecked: boolean;
  consistencyCheck: MaterialConsistencyStatus;
  dedupeKey: string;
  materialStatus: MaterialStatus;
  /** 该练习集现在是否「只含已通过题」。 */
  hasApprovedOnly: boolean;
}

/**
 * 裁决一道练习题（采纳 / 待复核 / 拒绝 / 退役态以外的状态变更）。
 *
 * 带 `edits` 时会**重新过一遍自检**（`checkExerciseDraft`）：
 * - 依据类失败（引用为空 / 段落不存在 / 引用无法回验）→ `PRECONDITION`：
 *   这不是用户填错，而是这道题的证据没了，改也改不好；
 * - 其它失败 → `VALIDATION`（选项数、正确答案不在选项里…用户能直接修）。
 * 通过后**重算 `dedupeKey`**：题干或答案变了，去重身份也必须跟着变，
 * 否则两次编辑会把两道不同的题压成一道。
 *
 * @param raw `{ exerciseId, reviewStatus, edits? }`
 */
export async function reviewExerciseAction(
  raw: unknown,
): Promise<ActionResult<ReviewExerciseData>> {
  const parsed = exerciseReviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { exerciseId, reviewStatus, edits } = parsed.data;

  const target = await prisma.generatedExercise.findUnique({
    where: { id: exerciseId },
    select: {
      id: true,
      materialId: true,
      setId: true,
      chunkId: true,
      type: true,
      targetSkill: true,
      subskill: true,
      difficultyEstimate: true,
      prompt: true,
      answerJson: true,
      explanation: true,
      evidenceQuote: true,
      consistencyCheck: true,
      dedupeKey: true,
    },
  });
  if (!target) {
    return fail('NOT_FOUND', '这道题不存在，可能已被删除（重新生成练习可再产出）');
  }

  const materialStatus = await readMaterialStatus(target.materialId);
  if (!materialStatus) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_MATERIAL_STATUSES.includes(materialStatus)) {
    return fail('PRECONDITION', '材料还在处理中，现在不能裁决练习题');
  }

  const answer = readAnswer(target.answerJson);

  if (!edits) {
    await prisma.generatedExercise.update({
      where: { id: target.id },
      data: { reviewStatus },
    });
    await recomputeSetFlags(target.setId);
    const gate = await settleMaterialReviewStatus(target.materialId);
    const after = await readMaterialStatus(target.materialId);
    revalidateExercisePaths(target.materialId);

    return ok<ReviewExerciseData>({
      exerciseId: target.id,
      reviewStatus,
      rechecked: false,
      consistencyCheck: target.consistencyCheck as MaterialConsistencyStatus,
      dedupeKey: target.dedupeKey,
      materialStatus: after ?? materialStatus,
      hasApprovedOnly: gate.pendingTotal === 0,
    });
  }

  // ── 带编辑：重新自检 ────────────────────────────────────────────────────
  const chunk = await prisma.contentChunk.findUnique({
    where: { id: target.chunkId },
    select: { id: true, text: true },
  });

  const nextOptions = edits.options ?? answer.options;
  const nextCorrectKey = edits.correctKey ?? answer.correctKey;
  const nextQuote = edits.evidenceQuote ?? target.evidenceQuote;
  const nextPrompt = edits.prompt ?? target.prompt;
  const nextExplanation = edits.explanation ?? target.explanation;

  const checked = checkExerciseDraft({
    type: target.type,
    targetSkill: target.targetSkill,
    subskill: edits.subskill ?? target.subskill,
    difficulty: edits.difficultyEstimate ?? target.difficultyEstimate,
    prompt: nextPrompt,
    options: nextOptions,
    correctKey: nextCorrectKey,
    explanation: nextExplanation,
    evidenceQuote: nextQuote,
    chunkId: target.chunkId,
    chunkText: chunk?.text ?? null,
  });

  if (!checked.ok) {
    const message = checked.failures.map((item) => item.messageZh).join('；');
    return hasQuoteFailure(checked.failures)
      ? fail('PRECONDITION', `这道题的原文依据有问题，保存不了：${message}`)
      : fail('VALIDATION', message);
  }

  await prisma.generatedExercise.update({
    where: { id: target.id },
    data: {
      prompt: nextPrompt.trim(),
      answerJson: checked.answerJson,
      explanation: nextExplanation.trim(),
      evidenceQuote: nextQuote.trim(),
      subskill: edits.subskill ?? target.subskill,
      difficultyEstimate: edits.difficultyEstimate ?? target.difficultyEstimate,
      consistencyCheck: checked.consistencyCheck,
      consistencyNote: checked.consistencyNote,
      dedupeKey: checked.dedupeKey,
      reviewStatus,
    },
  });

  await recomputeSetFlags(target.setId);
  await settleMaterialReviewStatus(target.materialId);
  const after = await readMaterialStatus(target.materialId);
  revalidateExercisePaths(target.materialId);

  const stillApprovedOnly =
    (
      await prisma.generatedExercise.count({
        where: { setId: target.setId, retiredAt: null, reviewStatus: { not: 'approved' } },
      })
    ) === 0;

  return ok<ReviewExerciseData>({
    exerciseId: target.id,
    reviewStatus,
    rechecked: true,
    consistencyCheck: checked.consistencyCheck,
    dedupeKey: checked.dedupeKey,
    materialStatus: after ?? materialStatus,
    hasApprovedOnly: stillApprovedOnly,
  });
}

// ───────────────────────── ③ 批量裁决 ─────────────────────────

export interface BulkReviewExercisesData {
  /** 真正被更新的行数（0 不是错误：可能别人已经处理过）。 */
  updated: number;
  reviewStatus: 'approved' | 'rejected';
  materialStatus: MaterialStatus;
  pendingTotal: number;
}

/**
 * 批量裁决（只允许全采纳 / 全拒绝）。
 *
 * `updateMany` 必须带 `materialId` 条件：`ids` 来自前端，只按 id 更新的话，
 * 构造一串别的材料的 id 就能跨材料改数据。带上之后越权 id 自然变成 0 行
 * （**不报错**，也不泄漏"这条 id 存在"）。
 *
 * @param raw `{ materialId, ids, reviewStatus }`
 */
export async function bulkReviewExercisesAction(
  raw: unknown,
): Promise<ActionResult<BulkReviewExercisesData>> {
  const parsed = exerciseBulkReviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { materialId, ids, reviewStatus } = parsed.data;
  const materialStatus = await readMaterialStatus(materialId);
  if (!materialStatus) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_MATERIAL_STATUSES.includes(materialStatus)) {
    return fail('PRECONDITION', '材料还在处理中，现在不能批量裁决练习题');
  }

  // 先记下涉及哪些练习集：状态变了之后这些集的 must-flag 都要重算
  const touched = await prisma.generatedExercise.findMany({
    where: { materialId, id: { in: ids } },
    distinct: ['setId'],
    select: { setId: true },
  });

  const result = await prisma.generatedExercise.updateMany({
    where: { materialId, id: { in: ids }, retiredAt: null },
    data: { reviewStatus },
  });

  for (const row of touched) {
    await recomputeSetFlags(row.setId);
  }

  const gate = await settleMaterialReviewStatus(materialId);
  const after = await readMaterialStatus(materialId);
  revalidateExercisePaths(materialId);

  return ok<BulkReviewExercisesData>({
    updated: result.count,
    reviewStatus,
    materialStatus: after ?? materialStatus,
    pendingTotal: gate.pendingTotal,
  });
}

// ───────────────────────── ④ 退役 ─────────────────────────

export interface RetireExerciseData {
  exerciseId: string;
  retiredAt: string;
  retiredCount: number;
  materialStatus: MaterialStatus;
}

/**
 * 退役一道题（永久不再使用，但保留历史作答）。
 *
 * 为什么不直接删：`ExerciseAttempt` 是用户自己的练习记录，删题会连带删掉
 * 「我做过这道题」的事实。退役保留行 + `retiredAt`，只在"还能不能作答"上生效。
 *
 * @param raw `{ exerciseId, reason }`
 */
export async function retireExerciseAction(
  raw: unknown,
): Promise<ActionResult<RetireExerciseData>> {
  const parsed = exerciseRetireSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const target = await prisma.generatedExercise.findUnique({
    where: { id: parsed.data.exerciseId },
    select: { id: true, materialId: true, setId: true, retiredAt: true },
  });
  if (!target) return fail('NOT_FOUND', '这道题不存在，可能已被删除');

  const materialStatus = await readMaterialStatus(target.materialId);
  if (!materialStatus) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_MATERIAL_STATUSES.includes(materialStatus)) {
    return fail('PRECONDITION', '材料还在处理中，现在不能退役练习题');
  }

  const retiredAt = target.retiredAt ?? new Date();
  await prisma.generatedExercise.update({
    where: { id: target.id },
    data: {
      reviewStatus: 'retired' satisfies MaterialExerciseReviewStatus,
      retiredAt,
      retireReason: parsed.data.reason.trim(),
    },
  });

  await recomputeSetFlags(target.setId);
  await settleMaterialReviewStatus(target.materialId);
  const after = await readMaterialStatus(target.materialId);
  revalidateExercisePaths(target.materialId);

  const retiredCount = await prisma.generatedExercise.count({
    where: { setId: target.setId, retiredAt: { not: null } },
  });

  return ok<RetireExerciseData>({
    exerciseId: target.id,
    retiredAt: retiredAt.toISOString(),
    retiredCount,
    materialStatus: after ?? materialStatus,
  });
}

// ───────────────────────── ⑤ 作答 ─────────────────────────

export interface SubmitExerciseAttemptData {
  attemptId: string;
  isCorrect: boolean;
  correctKey: string;
  explanation: string;
  evidenceQuote: string;
  consistencyCheck: MaterialConsistencyStatus;
  consistencyNote: string | null;
  /** 作答时的审核状态快照（历史语义不被后续改状态篡改）。 */
  reviewStatusAtAttempt: MaterialExerciseReviewStatus;
  /** 这次作答是否允许该题进入正式排程/测评（只有 `approved` 为 true）。 */
  canEnterPlacement: boolean;
  /** 实际落库的证据类型（PRACTICE_ONLY；不会创建 `EvidenceRecord`）。 */
  evidenceType: MaterialAttemptEvidenceType;
}

/**
 * 提交一次作答。
 *
 * **不创建 `EvidenceRecord`**（ADR-08）：材料客观题是练习，不是独立表现证据。
 * 落库只有一条 `ExerciseAttempt`，`evidenceType` 恒为 `PRACTICE_ONLY`、
 * `evidenceId` 恒为 null；返回里给出 `canEnterPlacement`，让上层知道
 * "这道题有没有资格进正式排程"，而不是偷偷把这次作答当成证据。
 *
 * @param raw `{ exerciseId, selectedKey, elapsedSec? }`
 */
export async function submitExerciseAttemptAction(
  raw: unknown,
): Promise<ActionResult<SubmitExerciseAttemptData>> {
  const parsed = exerciseAttemptSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const target = await prisma.generatedExercise.findUnique({
    where: { id: parsed.data.exerciseId },
    select: {
      id: true,
      materialId: true,
      setId: true,
      targetSkill: true,
      answerJson: true,
      explanation: true,
      evidenceQuote: true,
      consistencyCheck: true,
      consistencyNote: true,
      reviewStatus: true,
      retiredAt: true,
    },
  });
  if (!target) return fail('NOT_FOUND', '这道题不存在，可能已被删除');

  const materialStatus = await readMaterialStatus(target.materialId);
  if (!materialStatus) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!PRACTICABLE_MATERIAL_STATUSES.includes(materialStatus)) {
    return fail('PRECONDITION', '材料还在处理中（或已失败），现在不能作答');
  }

  const reviewStatusAtAttempt =
    (target.reviewStatus as MaterialExerciseReviewStatus) ?? 'draft';
  const decision = decideExerciseUse(reviewStatusAtAttempt, 'PRACTICE_ONLY');
  if (!decision.canPractice) {
    return fail('PRECONDITION', decision.reasonZh ?? '这道题当前不可作答');
  }

  const answer = readAnswer(target.answerJson);
  const selectedKey = parsed.data.selectedKey.trim();
  if (!answer.options.some((option) => option.key === selectedKey)) {
    return fail('VALIDATION', `「${selectedKey}」不是这道题的选项`);
  }
  if (answer.correctKey.length === 0) {
    return fail(
      'PRECONDITION',
      '这道题没有可用的正确答案（数据异常），暂不能判分；请换一道题或请人工复核',
    );
  }

  const isCorrect = selectedKey === answer.correctKey;
  const evidenceType: MaterialAttemptEvidenceType = decision.evidenceType ?? 'PRACTICE_ONLY';

  const attempt = await prisma.exerciseAttempt.create({
    data: {
      materialId: target.materialId,
      setId: target.setId,
      exerciseId: target.id,
      responseJson:
        stringify({
          selectedKey,
          isCorrect,
          ...(parsed.data.elapsedSec !== undefined ? { elapsedSec: parsed.data.elapsedSec } : {}),
        }) ?? '{}',
      isCorrect,
      reviewStatusAtAttempt,
      // ADR-08：材料题作答不写 EvidenceRecord，只留练习痕迹
      evidenceId: null,
      evidenceType,
    },
    select: { id: true },
  });

  revalidatePath(`/exercises/${target.setId}`);
  revalidatePath(`/materials/${target.materialId}/exercises`);

  return ok<SubmitExerciseAttemptData>({
    attemptId: attempt.id,
    isCorrect,
    correctKey: answer.correctKey,
    explanation: target.explanation,
    evidenceQuote: target.evidenceQuote,
    consistencyCheck: target.consistencyCheck as MaterialConsistencyStatus,
    consistencyNote: target.consistencyNote,
    reviewStatusAtAttempt,
    canEnterPlacement: decision.canEnterPlacement,
    evidenceType,
  });
}
