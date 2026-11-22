/**
 * 阶段 5：generating —— 用**已采纳**的分析结果生成客观题（T11）。
 *
 * 三条设计判断，逐条对应规格：
 *
 * 1. **出题依据只能来自人已采纳的结果**（`reviewStatus ∈ {accepted, edited}`，
 *    且种别 ∈ KEYWORD / COLLOCATION / KEY_SENTENCE / PARAGRAPH_GIST）。
 *    没有依据时**不是失败**，而是带着原因回到 `review_required` ——
 *    「这份材料还没审过、所以出不了题」是一句正常提示，不是错误。
 * 2. **单次 tick 限量、可续跑**：每次最多 `aiCallsPerTick` 批、`tickBudgetMs` 内结束，
 *    先把批次跑完再收尾；批没跑完就返回 `generating`（`jobStatus='running'`），
 *    下一个 tick 接着跑。续跑判据是 `existingChunkIds`：**活动练习集里已经有题的 chunk
 *    不再重复花钱**，所以「点了两次生成练习」不会把同一段原文出两遍题。
 * 3. **自检不过的题一律不写库**：`checkExerciseDraft()` 是唯一裁决点
 *    （结构硬失败 + 引用回验 + 一致性自检），这里只负责把它的结论落库
 *    并把「丢了几条 / 重复几条」写进 `statusReason`，让用户看得见代价。
 */

import {
  MATERIAL_EXERCISE_TYPES,
  MATERIAL_LIMITS,
  type MaterialExerciseReviewStatus,
  type MaterialExerciseType,
  type MaterialStatus,
} from '@/lib/constants';
import { generateExercises, type AiMaterialChunk } from '@/lib/ai/material';
import type { MaterialExerciseItem } from '@/lib/ai/structured';
import { prisma } from '@/lib/prisma';
import {
  checkExerciseDraft,
  estimateExerciseSetMinutes,
  EXERCISE_ANCHOR_KINDS,
  EXERCISE_ANCHOR_REVIEW_STATUSES,
  MIN_EXERCISE_SET_MINUTES,
  type ExerciseDraftInput,
} from '@/lib/materials/exerciseCheck';
import {
  addAiUsage,
  emptyAiUsage,
  materialErrorCodeOf,
  stageCancelled,
  stageFailure,
  type StageContext,
  type StageHandler,
  type StageOutcome,
} from '../stageContract';

/** 批次进度用的单位标签；同时用于判断「上个 tick 是否已在 generating 里跑过」。 */
const BATCH_UNIT = '批次';

/** 送给 AI 的题型清单（与 `MATERIAL_EXERCISE_TYPES` 保持单一来源）。 */
const EXERCISE_TYPES_ARG = MATERIAL_EXERCISE_TYPES.join(',');

/** 没有已采纳结果时的 `statusReason`（测试与 UI 都用它判断"出不了题"）。 */
export const GENERATING_NO_ANCHOR_REASON =
  '还没有已采纳的分析结果可用于出题：请先在 AI 分析页采纳（或修改后采纳）至少一条结果，再回来生成练习';

/** 收尾时 `statusReason` 的输入（每一档都要能被单独看见，T12 §7.2）。 */
export interface GeneratingReasonInput {
  created: number;
  /** 依据无法核验 / 格式不合规而被丢弃的条数。 */
  dropped: number;
  /** 与已有题目重复而跳过的条数。 */
  duplicates: number;
  /** 标注的来源块不存在的条数（AI 编了不存在的段落序号）。 */
  missingChunk: number;
  /** 此前已出过题、本轮跳过的段落数。 */
  skippedChunks: number;
  limitReached: boolean;
  budgetHit: boolean;
}

/**
 * 拼收尾文案。
 *
 * 抽成纯函数的原因（T12 §7.2）：四种"没进库"的原因（依据不可核验 / 重复 /
 * 来源块缺失 / 本轮跳过）**必须分项可见**。混成一个数字之后，排障只能靠猜；
 * 而拼在一段字符串里又没法单测。这里把拼装拿出来，逐档断言就能覆盖。
 *
 * 还有一个语义细节：「已生成 0 道」单独出现是自相矛盾的（用户会以为跑失败了），
 * 所以当产出为 0 而有段落被跳过时，**必须紧跟跳过原因**。
 *
 * @param input 见 `GeneratingReasonInput`
 */
export function buildGeneratingStatusReason(input: GeneratingReasonInput): string {
  const reasons: string[] = [];

  if (input.created > 0) {
    reasons.push(`已生成 ${input.created} 道练习题`);
  } else if (input.skippedChunks > 0) {
    reasons.push(
      `已生成 0 道练习题：${input.skippedChunks} 段原文此前已出过题，本轮跳过（没有重复计费）`,
    );
  } else {
    reasons.push('已生成 0 道练习题');
  }

  if (input.limitReached) reasons.push(`已达单材料 ${MATERIAL_LIMITS.maxExercises} 道的上限`);
  if (input.dropped > 0) reasons.push(`${input.dropped} 道依据无法核验或格式不合规，已丢弃`);
  if (input.duplicates > 0) reasons.push(`${input.duplicates} 道与前题重复，已跳过`);
  if (input.missingChunk > 0) reasons.push(`${input.missingChunk} 道标注的来源块不存在，已丢弃`);
  if (input.budgetHit) {
    reasons.push('本次运行 AI 调用已达上限，可再次点「生成练习」继续补齐');
  }

  return reasons.join('；');
}

/** 一道题的生成顺序快照（用于 `orderingJson`）。 */
type OrderingRow = { id: string; chunkId: string; type: string };

interface ExerciseChunk {
  id: string;
  seq: number;
  page: number | null;
  paragraphIndex: number | null;
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * 按条数 + 字符数切批（与 `analyzing` 的口径一致，但独立实现）。
 *
 * 为什么不复用 `buildChunkBatches`：那个函数接收的是 `analyzing` 的完整 chunk 行
 * （含 `suspicionFlags`），把两处的行结构强行绑定会让任一阶段加字段都变成耦合。
 * 批次规则本身只有两行，各自持有更清楚。
 *
 * @param chunks 待出题的 chunk（按 seq 升序）
 */
export function buildExerciseBatches(
  chunks: readonly ExerciseChunk[],
  options: { perBatch?: number; maxChars?: number } = {},
): ExerciseChunk[][] {
  const perBatch = options.perBatch ?? MATERIAL_LIMITS.chunksPerAiCall;
  const maxChars = options.maxChars ?? MATERIAL_LIMITS.maxInputCharsPerCall;

  const batches: ExerciseChunk[][] = [];
  let current: ExerciseChunk[] = [];
  let chars = 0;

  for (const chunk of chunks) {
    const wouldOverflow = current.length > 0 && chars + chunk.text.length > maxChars;
    if (current.length >= perBatch || wouldOverflow) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(chunk);
    chars += chunk.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 取出现次数最多的值（并列时取第一个遇到的，保证结果稳定）。 */
function dominant<T extends string>(values: readonly T[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** 找（或建）这份材料的**唯一活动练习集**。 */
async function ensureActiveSet(materialId: string, materialTitle: string): Promise<string> {
  const existing = await prisma.materialExerciseSet.findFirst({
    where: { materialId, isActive: true },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.materialExerciseSet.create({
    data: {
      materialId,
      title: `${materialTitle} · 练习`,
      targetSkill: 'READING',
      estimatedMinutes: MIN_EXERCISE_SET_MINUTES,
      hasApprovedOnly: false,
      isActive: true,
    },
    select: { id: true },
  });
  return created.id;
}

/** 把一道 AI 题目转成自检入参。 */
function toDraft(item: MaterialExerciseItem, chunk: ExerciseChunk): ExerciseDraftInput {
  return {
    type: item.type,
    targetSkill: item.target_skill,
    subskill: item.subskill ?? null,
    difficulty: item.difficulty ?? null,
    prompt: item.prompt,
    options: item.options,
    correctKey: item.correct_key,
    explanation: item.explanation,
    evidenceQuote: item.evidence_quote,
    chunkId: chunk.id,
    chunkText: chunk.text,
  };
}

/** 收尾：把练习集的题量派生字段（顺序、时长、是否全绿、主技能/难度）写回去。 */
async function finalizeSet(setId: string): Promise<void> {
  const rows: OrderingRow[] = await prisma.generatedExercise.findMany({
    where: { setId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, chunkId: true, type: true },
  });

  const live = await prisma.generatedExercise.findMany({
    where: { setId, retiredAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, reviewStatus: true, targetSkill: true, difficultyEstimate: true },
  });

  const hasApprovedOnly =
    live.length > 0
    && live.every((row) => (row.reviewStatus as MaterialExerciseReviewStatus) === 'approved');

  const mainSkill = dominant(live.map((row) => row.targetSkill));
  const mainDifficulty = dominant(
    live
      .map((row) => row.difficultyEstimate)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );

  await prisma.materialExerciseSet.update({
    where: { id: setId },
    data: {
      orderingJson: JSON.stringify(rows.map((row) => row.id)),
      estimatedMinutes: estimateExerciseSetMinutes(live.length),
      hasApprovedOnly,
      ...(mainSkill ? { targetSkill: mainSkill } : {}),
      ...(mainDifficulty ? { difficultyLevel: mainDifficulty } : {}),
    },
  });
}

export const generatingStage: StageHandler = async (
  ctx: StageContext,
): Promise<StageOutcome> => {
  const { material } = ctx;

  // ── ① 出题依据：人已采纳的分析结果 → 涉及的 chunk ──────────────────────
  const anchors = await prisma.extractionResult.findMany({
    where: {
      materialId: material.id,
      kind: { in: [...EXERCISE_ANCHOR_KINDS] },
      reviewStatus: { in: [...EXERCISE_ANCHOR_REVIEW_STATUSES] },
      chunkId: { not: null },
    },
    select: { chunkId: true },
  });
  const anchorChunkIds = new Set<string>();
  for (const row of anchors) {
    if (row.chunkId) anchorChunkIds.add(row.chunkId);
  }

  if (anchorChunkIds.size === 0) {
    // 没有依据 → 不是失败，是「还轮不到出题」
    return {
      to: 'review_required',
      stage: 'generating',
      progress: { done: 0, total: 0, unitLabel: BATCH_UNIT },
      statusReason: GENERATING_NO_ANCHOR_REASON,
      jobStatus: 'succeeded',
      didWork: true,
    };
  }

  // ── ② chunk 正文（回验与送 AI 都要用） ─────────────────────────────────
  const chunkRows: ExerciseChunk[] = await prisma.contentChunk.findMany({
    where: { id: { in: [...anchorChunkIds] } },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      seq: true,
      page: true,
      paragraphIndex: true,
      text: true,
      charStart: true,
      charEnd: true,
    },
  });
  if (chunkRows.length === 0) {
    return stageFailure('generating', 'NO_TEXT', '找不到可出题的内容块，请重新解析后再试');
  }

  // ── ③ 活动练习集 + 续跑判据 ────────────────────────────────────────────
  const setId = await ensureActiveSet(material.id, material.title);

  const existingRows = await prisma.generatedExercise.findMany({
    where: { materialId: material.id, setId },
    distinct: ['chunkId'],
    select: { chunkId: true },
  });
  const existingChunkIds = new Set(existingRows.map((row) => row.chunkId));

  const pendingChunks = chunkRows.filter((chunk) => !existingChunkIds.has(chunk.id));
  const batches = buildExerciseBatches(pendingChunks);
  /**
   * `done` 每个 tick 从 0 起。
   *
   * 与 `analyzing` 不同：那里的 `done` 是「这一轮已跑完的批数」，要跨 tick 累加；
   * 而这里**续跑是靠 `existingChunkIds` 表达的**（有题就不再跑），所以每次 tick
   * 重新算 `pendingChunks` 后 `total` 已经变小，再沿用旧 `done` 会算出 `done > total`。
   */
  const total = batches.length;
  /**
   * 本轮**跳过**的 chunk 数（T12 §7.1）：因为它们此前已经出过题。
   *
   * 这个数字必须写进进度与文案：否则界面上会出现「批次 4 / 4」+「已生成 0 道题」
   * 这种自相矛盾的组合 —— 数字都对，但用户读到的是"系统算错了"。
   */
  const skippedChunks = chunkRows.length - pendingChunks.length;

  const usage = emptyAiUsage();
  let completed = 0;
  let created = 0;
  let dropped = 0;
  let duplicates = 0;
  /**
   * `source_chunk_seq` 找不到对应段落块的条数（T12 §7.2）。
   *
   * 与 `dropped` 分开计的原因：一个是"模型给的引用过不了回验"，一个是"模型指的
   * 段落在这批里根本不存在"，修法完全不同（前者是内容问题，后者是协议/批次问题）。
   * 混成一个数字，排障时只能靠猜。**只进文案，不加字段**。
   */
  let missingChunk = 0;
  let failedBatches = 0;
  let lastErrorCode = 'INTERNAL_STORAGE';
  let lastErrorMessage = '';
  let budgetHit = false;

  let setCount = await prisma.generatedExercise.count({
    where: { setId, retiredAt: null },
  });

  // 单材料跨练习集去重（D-10）：同一道题不该因为"重新生成过一次"存在两遍
  const dedupeKeys = new Set(
    (
      await prisma.generatedExercise.findMany({
        where: { materialId: material.id },
        select: { dedupeKey: true },
      })
    ).map((row) => row.dedupeKey),
  );

  const budgetExhausted = (): boolean =>
    ctx.job.aiCallCount + usage.calls >= MATERIAL_LIMITS.maxAiCalls
    || ctx.job.inputTokens + usage.inputTokens >= MATERIAL_LIMITS.maxTotalInputTokens;

  // ── ④ 逐批出题（本 tick 最多 aiCallsPerTick 批） ────────────────────────
  while (completed < total) {
    if (usage.calls >= MATERIAL_LIMITS.aiCallsPerTick) break;
    if (Date.now() > ctx.deadline) break;
    if (setCount >= MATERIAL_LIMITS.maxExercises) break;
    if (budgetExhausted()) {
      budgetHit = true;
      break;
    }
    if (await ctx.isCancelled()) return stageCancelled(ctx);

    const batch = batches[completed];
    const result = await generateExercises({
      prisma,
      materialId: material.id,
      materialJobId: ctx.job.id,
      materialTitle: material.title,
      chunks: batch.map(
        (chunk): AiMaterialChunk => ({
          id: chunk.id,
          seq: chunk.seq,
          page: chunk.page,
          paragraphIndex: chunk.paragraphIndex,
          text: chunk.text,
        }),
      ),
      exerciseTypes: EXERCISE_TYPES_ARG,
      questionBudget: Math.max(
        1,
        Math.min(batch.length * 2, MATERIAL_LIMITS.maxExercises - setCount),
      ),
    });

    if (!result.ok) {
      failedBatches += 1;
      lastErrorCode = materialErrorCodeOf(result.code);
      lastErrorMessage = result.message;
      // 失败也消耗了一次调用：额度必须照实计，否则重试会无限免费
      addAiUsage(usage, { calls: 1, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
      completed += 1;
      continue;
    }

    addAiUsage(usage, {
      calls: 1,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostUsd: result.usage.estimatedCostUsd,
    });
    // AI 层已经丢掉一批"引用回验不过"的题，这里并入 dropped 口径
    dropped += result.droppedUnverifiable;

    const chunkBySeq = new Map(batch.map((chunk) => [chunk.seq, chunk]));

    for (const item of result.exercises) {
      if (setCount >= MATERIAL_LIMITS.maxExercises) break;

      const chunk = chunkBySeq.get(item.source_chunk_seq);
      if (!chunk) {
        // AI 编了一个本批不存在的段落序号：引用无从核验，直接丢
        missingChunk += 1;
        continue;
      }

      const checked = checkExerciseDraft(toDraft(item, chunk));
      if (!checked.ok) {
        dropped += 1;
        continue;
      }
      if (dedupeKeys.has(checked.dedupeKey)) {
        duplicates += 1;
        continue;
      }

      await prisma.generatedExercise.create({
        data: {
          materialId: material.id,
          setId,
          chunkId: chunk.id,
          type: item.type as MaterialExerciseType,
          targetSkill: item.target_skill,
          subskill: item.subskill ?? null,
          difficultyEstimate: item.difficulty ?? null,
          prompt: item.prompt.trim(),
          answerJson: checked.answerJson,
          explanation: item.explanation.trim(),
          evidenceQuote: item.evidence_quote.trim(),
          page: chunk.page,
          paragraphIndex: chunk.paragraphIndex,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          isAiGenerated: true,
          reviewStatus: 'draft',
          consistencyCheck: checked.consistencyCheck,
          consistencyNote: checked.consistencyNote,
          dedupeKey: checked.dedupeKey,
          model: result.usage.status === 'MOCK' ? 'mock' : null,
          promptVersionId: result.usage.promptVersionId,
          aiCallLogId: result.usage.logId,
        },
      });

      dedupeKeys.add(checked.dedupeKey);
      setCount += 1;
      created += 1;
    }

    completed += 1;
  }

  // ── ⑤ 全部批次都失败 → 这一阶段是真的失败（不是"没依据"那种正常停靠） ──
  if (total > 0 && failedBatches === total) {
    return stageFailure(
      'generating',
      lastErrorCode,
      `练习生成失败：${lastErrorMessage || 'AI 未能返回可用的题目'}`,
    );
  }

  // ── ⑥ 还有批没跑完（且不是预算/上限导致）→ 留在 generating 等下一个 tick ──
  const limitReached = setCount >= MATERIAL_LIMITS.maxExercises;
  if (completed < total && !budgetHit && !limitReached) {
    return {
      to: 'generating',
      stage: 'generating',
      progress: { done: completed, total, unitLabel: BATCH_UNIT, skipped: skippedChunks },
      aiUsage: usage,
      jobStatus: 'running',
      didWork: true,
    };
  }

  // ── ⑦ 收尾：派生字段写回练习集，交给人审核 ──────────────────────────────
  await finalizeSet(setId);

  const statusReason = buildGeneratingStatusReason({
    created,
    dropped,
    duplicates,
    missingChunk,
    skippedChunks,
    limitReached,
    budgetHit,
  });

  return {
    to: 'review_required' satisfies MaterialStatus,
    stage: 'generating',
    progress: { done: total, total, unitLabel: BATCH_UNIT, skipped: skippedChunks },
    statusReason,
    aiUsage: usage,
    jobStatus: 'succeeded',
    didWork: true,
  };
};
