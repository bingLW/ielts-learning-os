'use server';

/**
 * AI 分析审核 / 续跑（T10）的六个 Server Action。
 *
 * 统一约定与 `actions/materials.ts` 一致：`safeParse` 失败走 `failValidation`、
 * 失败**返回**不 throw、写库后 `revalidatePath`。
 *
 * 这一层刻意只做「前置断言 + 一次写库 + 结算」，不自己判断
 * 「材料该不该变成 ready」—— 那是 `domain/materialReviewGate` 的唯一职责，
 * 本文件最多调用 `services/materialReviewSettle` 让它落库。
 */

import { revalidatePath } from 'next/cache';
import { summarizeMaterial } from '@/lib/ai/material';
import {
  MATERIAL_LIMITS,
  type MaterialReviewStatus,
  type MaterialStatus,
} from '@/lib/constants';
import type { ReviewGateResult } from '@/lib/domain/materialReviewGate';
import { parseJson, stringify } from '@/lib/json';
import { canTransition } from '@/lib/materials/stateMachine';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import {
  extractionBulkReviewSchema,
  extractionReviewSchema,
  materialAnalysisTargetSchema,
} from '@/lib/schema/materialAnalysis';
import { listByKind, upsertSummary } from '@/lib/services/materialExtractionRepo';
import { materializeVocabularyCandidates } from '@/lib/services/materialCandidateRepo';
import { settleMaterialReviewStatus } from '@/lib/services/materialReviewSettle';
import type { ActionResult } from '@/lib/types';

/** 允许裁决 AI 结果的两个状态：分析已完成，或已按「部分可用」定稿。 */
const REVIEWABLE_STATUSES: readonly MaterialStatus[] = ['review_required', 'partial'];

/** 审核页与阅读页共用的失效路径。 */
function revalidateAnalysisPaths(materialId: string): void {
  revalidatePath(`/materials/${materialId}/analysis`);
  revalidatePath(`/materials/${materialId}/read`);
  revalidatePath('/materials');
}

interface MaterialBrief {
  id: string;
  title: string;
  status: MaterialStatus;
  statusReason: string | null;
}

/** `progressJson` 的结构（与 pipeline 内部一致，这里只读需要的字段）。 */
interface JobProgressShape {
  done?: number;
  total?: number;
  unitLabel?: string;
  droppedUnverifiable?: number;
  msByStage?: Record<string, number>;
}

/** 读材料摘要（不存在返回 null，由调用方转成 `NOT_FOUND`）。 */
async function loadMaterial(materialId: string): Promise<MaterialBrief | null> {
  const row = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true, title: true, status: true, statusReason: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status as MaterialStatus,
    statusReason: row.statusReason,
  };
}

/** 读当前状态（写库后用来回填 DTO，避免页面拿到旧值）。 */
async function readStatus(materialId: string, fallback: MaterialStatus): Promise<MaterialStatus> {
  const row = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { status: true },
  });
  return (row?.status as MaterialStatus) ?? fallback;
}

// ───────────────────────── ① 单条裁决 ─────────────────────────

export interface ReviewExtractionResultData {
  id: string;
  reviewStatus: MaterialReviewStatus;
  materialStatus: MaterialStatus;
  gate: ReviewGateResult;
  /** 这次裁决顺带物化出的词汇候选数（best-effort，失败为 0）。 */
  vocabMaterialized: number;
}

/**
 * 裁决后顺带物化词汇候选（T12 §3）。
 *
 * **刻意不放进事务、也不让失败回滚**：候选物化是"把已采纳的关键词抄进候选表"，
 * 它失败不该让"我已经采纳了这条分析结果"这件事失效。但也不能静默：
 * 打 `console.warn` 并把条数回填给 UI（失败时 0，页面上还有独立的补建按钮兜底）。
 *
 * @param materialId 材料 id
 */
async function materializeCandidatesBestEffort(materialId: string): Promise<number> {
  try {
    const result = await materializeVocabularyCandidates(materialId);
    return result.created;
  } catch (error) {
    console.warn(
      `[materialAnalysis] 词汇候选物化失败（材料 ${materialId}）：`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}

/**
 * 裁决一条 AI 提取结果。
 *
 * 前置断言：
 * 1. 入参合法（`edited` 必须带 `editedPayload`，非 `edited` 必须不带）；
 * 2. 这条结果存在（否 → `NOT_FOUND`）；
 * 3. 材料处于 `review_required` / `partial`（否则 → `PRECONDITION`）。
 *
 * @param raw `{ id, reviewStatus, editedPayload? }`
 */
export async function reviewExtractionResultAction(
  raw: unknown,
): Promise<ActionResult<ReviewExtractionResultData>> {
  const parsed = extractionReviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const target = await prisma.extractionResult.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, materialId: true },
  });
  if (!target) {
    return fail('NOT_FOUND', '这条 AI 结果不存在，可能已被删除（重新分析可再次生成）');
  }

  const material = await loadMaterial(target.materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_STATUSES.includes(material.status)) {
    return fail('PRECONDITION', 'AI 分析还没结束（或材料已定稿），现在还不能裁决结果');
  }

  const reviewStatus = parsed.data.reviewStatus;
  await prisma.extractionResult.update({
    where: { id: target.id },
    data: {
      reviewStatus,
      // 只有 `edited` 会把用户改动写进 editedPayloadJson；
      // 其它裁决一律清空，避免「已拒绝」的行还留着旧编辑内容误导 UI。
      editedPayloadJson:
        reviewStatus === 'edited' ? (stringify(parsed.data.editedPayload) ?? null) : null,
      reviewedAt: reviewStatus === 'draft' ? null : new Date(),
    },
  });

  const vocabMaterialized =
    reviewStatus === 'accepted' || reviewStatus === 'edited'
      ? await materializeCandidatesBestEffort(target.materialId)
      : 0;

  const gate = await settleMaterialReviewStatus(target.materialId);
  const materialStatus = await readStatus(target.materialId, material.status);
  revalidateAnalysisPaths(target.materialId);
  if (vocabMaterialized > 0) revalidatePath(`/materials/${target.materialId}/vocabulary`);

  return ok<ReviewExtractionResultData>({
    id: target.id,
    reviewStatus,
    materialStatus,
    gate,
    vocabMaterialized,
  });
}

// ───────────────────────── ② 批量裁决 ─────────────────────────

export interface BulkReviewExtractionData {
  /** 真正被更新的行数（0 不是错误：可能别人已经处理过）。 */
  updated: number;
  reviewStatus: 'accepted' | 'rejected';
  materialStatus: MaterialStatus;
  gate: ReviewGateResult;
  /** 这次批量裁决顺带物化出的词汇候选数（best-effort，失败为 0）。 */
  vocabMaterialized: number;
}

/**
 * 批量采纳 / 批量拒绝。
 *
 * 为什么 `updateMany` 要带 `materialId` 条件：`ids` 来自前端，若只按 id 更新，
 * 构造一串别的材料的 id 就能跨材料改数据。带上 `materialId` 之后，
 * 越权 id 自然变成 0 行（**不报错**，也不泄漏"这条 id 存在"的信息）。
 *
 * @param raw `{ materialId, ids, reviewStatus }`
 */
export async function bulkReviewExtractionAction(
  raw: unknown,
): Promise<ActionResult<BulkReviewExtractionData>> {
  const parsed = extractionBulkReviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { materialId, ids, reviewStatus } = parsed.data;
  const material = await loadMaterial(materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_STATUSES.includes(material.status)) {
    return fail('PRECONDITION', 'AI 分析还没结束（或材料已定稿），现在还不能批量裁决');
  }

  const result = await prisma.extractionResult.updateMany({
    where: { materialId, id: { in: ids } },
    data: {
      reviewStatus,
      editedPayloadJson: null,
      reviewedAt: new Date(),
    },
  });

  const vocabMaterialized =
    reviewStatus === 'accepted' ? await materializeCandidatesBestEffort(materialId) : 0;

  const gate = await settleMaterialReviewStatus(materialId);
  const materialStatus = await readStatus(materialId, material.status);
  revalidateAnalysisPaths(materialId);
  if (vocabMaterialized > 0) revalidatePath(`/materials/${materialId}/vocabulary`);

  return ok<BulkReviewExtractionData>({
    updated: result.count,
    reviewStatus,
    materialStatus,
    gate,
    vocabMaterialized,
  });
}

// ───────────────────────── ③ 重新生成摘要 ─────────────────────────

export interface RegenerateSummaryData {
  /** 新摘要行的 id（旧摘要保留可追溯，读取端取最新）。 */
  extractionId: string;
  /** 通过原文回验的要点条数。 */
  keyPoints: number;
  droppedUnverifiable: number;
  materialStatus: MaterialStatus;
}

/** 摘要输入：优先用已入库的段落主旨（省 token），缺则退回原文。 */
async function summaryChunks(materialId: string) {
  const document = await prisma.parsedDocument.findFirst({
    where: { materialId, isCurrent: true },
    select: { id: true },
  });
  if (!document) return [];

  const chunks = await prisma.contentChunk.findMany({
    where: { parsedDocumentId: document.id },
    orderBy: { seq: 'asc' },
    select: { id: true, seq: true, page: true, paragraphIndex: true, text: true },
  });
  if (chunks.length === 0) return [];

  const gists = await listByKind(materialId, 'PARAGRAPH_GIST');
  const gistByChunk = new Map<string, string>();
  for (const row of gists) {
    const gist = row.payload.gist;
    if (row.chunkId && typeof gist === 'string' && gist.trim().length > 0) {
      gistByChunk.set(row.chunkId, gist);
    }
  }
  if (gistByChunk.size === 0) return chunks;
  return chunks.map((chunk) => ({ ...chunk, text: gistByChunk.get(chunk.id) ?? chunk.text }));
}

/**
 * 重新生成材料摘要。
 *
 * 三条硬约束：
 * 1. **要点必须能回验**：一条都没通过就不写库（AC-03 不允许无依据的 AI 结论）；
 * 2. **不覆盖旧摘要**：`upsertSummary` 是追加新行，只是把旧的**草稿**摘要
 *    降级成 `rejected`（未审核的旧摘要已经过期，留着会和新摘要一起排队）；
 * 3. **用量照记**：这次调用计入 job 的 AI 计量，重复点会一起吃 60 次上限。
 *
 * @param raw `{ materialId }`
 */
export async function regenerateMaterialSummaryAction(
  raw: unknown,
): Promise<ActionResult<RegenerateSummaryData>> {
  const parsed = materialAnalysisTargetSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const materialId = parsed.data.materialId;
  const material = await loadMaterial(materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_STATUSES.includes(material.status)) {
    return fail('PRECONDITION', 'AI 分析还没结束，现在没有可重新生成的摘要');
  }

  const chunks = await summaryChunks(materialId);
  if (chunks.length === 0) {
    return fail('PRECONDITION', '找不到当前正文分块，请重新解析后再试');
  }

  const job = await prisma.processingJob.findFirst({
    where: { materialId },
    orderBy: { startedAt: 'desc' },
    select: { id: true, aiCallCount: true, inputTokens: true, progressJson: true },
  });
  if (!job) return fail('PRECONDITION', '找不到处理任务，无法记录这次 AI 调用');

  // 额度是**单次运行**口径（没有按轮乘系数）：这个 job 自己的计数器已经顶格就拒绝
  if (
    job.aiCallCount >= MATERIAL_LIMITS.maxAiCalls
    || job.inputTokens >= MATERIAL_LIMITS.maxTotalInputTokens
  ) {
    return fail(
      'PRECONDITION',
      '这次运行的 AI 调用额度已经用完，无法再生成摘要（可重新开始一次分析）',
    );
  }

  const summary = await summarizeMaterial({
    prisma,
    materialId,
    materialJobId: job.id,
    materialTitle: material.title,
    chunks: chunks.map((chunk) => ({
      id: chunk.id,
      seq: chunk.seq,
      page: chunk.page,
      paragraphIndex: chunk.paragraphIndex,
      text: chunk.text,
    })),
  });

  if (!summary.ok) {
    return fail(
      summary.code === 'BUDGET_EXCEEDED' ? 'PRECONDITION' : 'INTERNAL',
      `重新生成摘要失败：${summary.message}`,
    );
  }

  const anchorQuote = summary.keyPoints[0]?.source_quote ?? '';
  if (anchorQuote.trim().length === 0) {
    return fail(
      'PRECONDITION',
      'AI 给出的摘要要点没能通过原文回验，因此没有保存（不会存下没有原文依据的结论）',
    );
  }

  const chunkIds = summary.keyPoints
    .map((point) => chunks.find((chunk) => chunk.seq === point.source_chunk_seq)?.id)
    .filter((id): id is string => typeof id === 'string');

  const extractionId = await prisma.$transaction(async (tx) => {
    // 未审核的旧摘要已过期：降级为 rejected，避免和新摘要一起排队
    await tx.extractionResult.updateMany({
      where: { materialId, kind: 'SUMMARY', reviewStatus: 'draft' },
      data: { reviewStatus: 'rejected', reviewedAt: new Date() },
    });

    const created = await upsertSummary(materialId, {
      summary: { ...summary.summary, key_points: summary.keyPoints },
      sourceChunkIds: chunkIds.length > 0 ? chunkIds : chunks.map((chunk) => chunk.id),
      sourceQuote: anchorQuote,
      aiCallLogId: summary.usage.logId,
      promptVersionId: summary.usage.promptVersionId,
      db: tx,
    });

    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        aiCallCount: { increment: 1 },
        inputTokens: { increment: summary.usage.inputTokens },
        outputTokens: { increment: summary.usage.outputTokens },
        estimatedCostUsd: { increment: summary.usage.estimatedCostUsd },
      },
    });

    // 材料级累计（与 pipeline 的口径一致：job 归零、材料累加）
    await tx.learningMaterial.update({
      where: { id: materialId },
      data: {
        aiCallCount: { increment: 1 },
        inputTokens: { increment: summary.usage.inputTokens },
        outputTokens: { increment: summary.usage.outputTokens },
        estimatedCostUsd: { increment: summary.usage.estimatedCostUsd },
      },
    });

    return created;
  });

  // 新摘要进来就是一条新的 draft → 材料必须留在（或回到）待审核
  await settleMaterialReviewStatus(materialId);
  const materialStatus = await readStatus(materialId, material.status);
  revalidateAnalysisPaths(materialId);

  return ok<RegenerateSummaryData>({
    extractionId,
    keyPoints: summary.keyPoints.length,
    droppedUnverifiable: summary.droppedUnverifiable,
    materialStatus,
  });
}

// ───────────────────────── ④ 跳过练习生成 ─────────────────────────

export interface SkipExerciseGenerationData {
  materialStatus: MaterialStatus;
  gate: ReviewGateResult;
}

/**
 * 跳过练习生成。
 *
 * 语义：分析已经做完，但我不需要这份材料的练习题。因为 `review_required → generating`
 * 不是合法边，一旦材料停在 `review_required`，练习生成**本来就不会自动再跑**，
 * 所以这个动作不需要额外的持久化开关（不新增字段、不写伪权限记录）——
 * 它只做两件事：按闸门结算一次，并把 `statusReason` 改成"已跳过"的说法。
 *
 * @param raw `{ materialId }`
 */
export async function skipExerciseGenerationAction(
  raw: unknown,
): Promise<ActionResult<SkipExerciseGenerationData>> {
  const parsed = materialAnalysisTargetSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const materialId = parsed.data.materialId;
  const material = await loadMaterial(materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (material.status !== 'review_required') {
    return fail('PRECONDITION', '只有「等待审核」的材料可以跳过练习生成');
  }

  const gate = await settleMaterialReviewStatus(materialId);
  const materialStatus = await readStatus(materialId, material.status);

  await prisma.learningMaterial.update({
    where: { id: materialId },
    data: {
      statusReason:
        materialStatus === 'ready'
          ? '已跳过练习生成；AI 结果已全部审核'
          : `已跳过练习生成 · ${gate.reasonZh}`,
    },
  });

  revalidateAnalysisPaths(materialId);
  return ok<SkipExerciseGenerationData>({ materialStatus, gate });
}

// ───────────────────────── ⑤ 继续分析（§0） ─────────────────────────

export interface ContinueAnalysisData {
  /** 新一轮运行的 job id（**不是**上一轮那个）。 */
  jobId: string;
  attempt: number;
  materialStatus: MaterialStatus;
  /** 已经有 AI 结果的 chunk 数（这一轮会被跳过）。 */
  analyzedChunks: number;
  /** 还要分析多少块（> 0 才会走到这里）。 */
  remainingChunks: number;
}

/** 统计「已分析 / 未分析」的 chunk 数（按 `ExtractionResult.chunkId` 去重）。 */
async function countChunks(materialId: string): Promise<{
  total: number;
  analyzed: number;
  remaining: number;
}> {
  const document = await prisma.parsedDocument.findFirst({
    where: { materialId, isCurrent: true },
    select: { id: true },
  });
  if (!document) return { total: 0, analyzed: 0, remaining: 0 };

  const [total, analyzedRows] = await Promise.all([
    prisma.contentChunk.count({ where: { parsedDocumentId: document.id } }),
    prisma.extractionResult.findMany({
      where: { materialId, chunkId: { not: null } },
      distinct: ['chunkId'],
      select: { chunkId: true },
    }),
  ]);

  const analyzed = analyzedRows.filter((row) => row.chunkId !== null).length;
  return { total, analyzed, remaining: Math.max(0, total - analyzed) };
}

/**
 * 继续分析剩余内容块（AI 调用触顶 / 摘要未生成后的续跑）。
 *
 * **新开一次运行**，不重开旧 job，也不乘任何系数：
 * - 新建 `ProcessingJob`（`attempt = 上次最大 attempt + 1`，四个计数器归零，
 *   `progressJson = null`），旧 job 一个字段都不动（它是历史记录，随时可追溯）；
 * - 材料回 `analyzing`，`statusReason` 清空（新运行还没有降级原因）。
 *
 * 为什么不是「重开同一个 job + 放大上限」：`maxAiCalls` 是**成本上限**，
 * 按点击次数乘系数等于每点一次白送 60 次调用，上限就失效了。现在的口径是
 * 「每次运行 60 次 + 跳过已分析的 chunk」→ 总调用量由**文档规模**决定
 * （`maxChunks / chunksPerAiCall` ≈ 100 批 + 摘要），与用户点几次无关。
 *
 * @param raw `{ materialId }`
 */
export async function continueAnalysisAction(
  raw: unknown,
): Promise<ActionResult<ContinueAnalysisData>> {
  const parsed = materialAnalysisTargetSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const materialId = parsed.data.materialId;
  const material = await loadMaterial(materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (material.status !== 'partial') {
    return fail('PRECONDITION', '只有「部分可用」的材料可以继续分析');
  }
  if (!canTransition('partial', 'analyzing')) {
    return fail('PRECONDITION', '当前状态不允许继续分析');
  }

  const document = await prisma.parsedDocument.findFirst({
    where: { materialId, isCurrent: true },
    select: { id: true },
  });
  if (!document) {
    return fail('PRECONDITION', '找不到当前解析版本，请重试（会从解析重新开始）');
  }

  const { analyzed, remaining } = await countChunks(materialId);
  if (remaining === 0) {
    return fail('PRECONDITION', '所有内容块都已分析过，无需继续');
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
        stage: 'analyzing',
        status: 'running',
        attempt,
        cancelRequested: false,
        // 新运行的计数器从 0 起：60 次上限是**单次运行**口径
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
      data: { status: 'analyzing', statusReason: null },
    });

    return created;
  });

  revalidateAnalysisPaths(materialId);
  revalidatePath(`/materials/${materialId}/processing`);

  return ok<ContinueAnalysisData>({
    jobId: job.id,
    attempt,
    materialStatus: 'analyzing',
    analyzedChunks: analyzed,
    remainingChunks: remaining,
  });
}

// ───────────────────────── ⑥ 确认部分可用 ─────────────────────────

export interface ConfirmPartialUseData {
  materialStatus: MaterialStatus;
  droppedUnverifiable: number;
}

/**
 * 确认「按部分可用继续」（`review_required → partial`）。
 *
 * 前置断言刻意很严：**必须已经没有待审项**，且**确实有结果被丢弃**。
 * 前者防止用户拿这个按钮绕过审核；后者防止把「全部核验通过」的材料
 * 误标成 partial（那会让 `ready` 永远到不了）。
 *
 * @param raw `{ materialId }`
 */
export async function confirmPartialUseAction(
  raw: unknown,
): Promise<ActionResult<ConfirmPartialUseData>> {
  const parsed = materialAnalysisTargetSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const materialId = parsed.data.materialId;
  const material = await loadMaterial(materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (material.status !== 'review_required') {
    return fail('PRECONDITION', '只有「等待审核」的材料可以确认按部分可用');
  }

  const gate = await settleMaterialReviewStatus(materialId);
  if (gate.pendingTotal > 0) {
    return fail('PRECONDITION', `还有 ${gate.pendingTotal} 条结果没审核，先审完再确认`);
  }
  if (!gate.requiresPartialConfirm) {
    return fail('PRECONDITION', '这份材料的 AI 结果都通过了原文核验，不需要降级为部分可用');
  }
  if (!canTransition('review_required', 'partial')) {
    return fail('PRECONDITION', '当前状态不允许转为部分可用');
  }

  const job = await prisma.processingJob.findFirst({
    where: { materialId },
    orderBy: { startedAt: 'desc' },
    select: { progressJson: true },
  });
  const progress = parseJson<JobProgressShape>(job?.progressJson, {}) ?? {};
  const droppedUnverifiable =
    typeof progress.droppedUnverifiable === 'number' && progress.droppedUnverifiable > 0
      ? progress.droppedUnverifiable
      : 0;

  await prisma.learningMaterial.update({
    where: { id: materialId },
    data: {
      status: 'partial',
      statusReason: `已按部分可用继续（${droppedUnverifiable} 条结果因原文依据无法核验已丢弃）`,
    },
  });

  revalidateAnalysisPaths(materialId);
  return ok<ConfirmPartialUseData>({
    materialStatus: 'partial',
    droppedUnverifiable,
  });
}
