/**
 * 阶段 4：analyzing —— AI 抽取（ADR-04 的四层防护全部在这里生效）。
 *
 * 单次 tick 的工作单位是「一批 chunk」（`chunksPerAiCall=8`，且按
 * `maxInputCharsPerCall=16000` 二次裁批），最多 `aiCallsPerTick=4` 批就返回，
 * 让位给前端 3s 轮询 —— 这正是 ADR-05 说的「把长任务切成有界小步」。
 *
 * 三条不可妥协的规则：
 * 1. **未通过回验的结果不入库**：`extractChunkBatch()` 已经丢了不合格项，
 *    `createExtractionResults()` 再拦一道（G1 / AC-03），两道都过不了才计
 *    `dropped_unverifiable`。
 * 2. **单次运行预算**：`aiCallCount >= maxAiCalls(60)` 或累计输入 token 超 260k →
 *    转 `partial` 并写明「已分析前 N/总 M」，等用户确认继续（§5）。
 *    用户确认后会**新开一次运行**（新 `ProcessingJob`，计数器归零），并且
 *    **跳过已有 `ExtractionResult` 的 chunk** —— 所以总调用量由文档规模决定
 *    （`maxChunks / chunksPerAiCall`），而不是由点击次数决定。
 * 3. **注入只标记不改变行为**：命中疑似话术只写 `ContentChunk.suspicionFlags`
 *    （ADR-04 L5），正文照常分析 —— 删内容会破坏原文完整性。
 */

import { MATERIAL_ERROR_MESSAGES_ZH, MATERIAL_LIMITS, type MaterialStatus } from '@/lib/constants';
import type { MaterialExtractItem } from '@/lib/ai/structured';
import { extractChunkBatch, summarizeMaterial, type AiMaterialChunk } from '@/lib/ai/material';
import { detectInjectionSuspicion, suspicionFlagsToColumn } from '@/lib/materials/injection';
import { prisma } from '@/lib/prisma';
import {
  createExtractionResults,
  listByKind,
  upsertSummary,
  type ExtractionKind,
  type ExtractionRowInput,
} from '@/lib/services/materialExtractionRepo';
import {
  addAiUsage as addUsage,
  emptyAiUsage as emptyUsage,
  materialErrorCodeOf as errorCodeOf,
  stageCancelled,
  stageFailure,
  type StageContext,
  type StageHandler,
  type StageOutcome,
} from '../stageContract';

/** 批次进度用的单位标签；也是判断「上个 tick 是否已在 analyzing 里跑过」的依据。 */
const BATCH_UNIT = '批次';

interface ChunkRow extends AiMaterialChunk {
  charStart: number;
  charEnd: number;
  suspicionFlags: string | null;
}

/** 把 chunk 切成批：先按条数（8）再按字符（16000），且绝不把单个 chunk 拆开。 */
export function buildChunkBatches(
  chunks: readonly ChunkRow[],
  options: {
    perBatch?: number;
    maxChars?: number;
  } = {},
): ChunkRow[][] {
  const perBatch = options.perBatch ?? MATERIAL_LIMITS.chunksPerAiCall;
  const maxChars = options.maxChars ?? MATERIAL_LIMITS.maxInputCharsPerCall;

  const batches: ChunkRow[][] = [];
  let current: ChunkRow[] = [];
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

/** 累计计量的小工具（一个 tick 内多次调用相加）—— 与 generating 共用同一份实现。 */

/** 抽取项 → 入库行（`sourceVerified` 恒 true：调用前已过回验）。 */
function toRow(
  materialId: string,
  item: MaterialExtractItem,
  chunk: ChunkRow | undefined,
  logId: string,
  promptVersionId: string,
): ExtractionRowInput {
  return {
    materialId,
    chunkId: chunk?.id ?? null,
    kind: item.kind as ExtractionKind,
    payload: item,
    sourceQuote: item.source_quote,
    page: chunk?.page ?? null,
    paragraphIndex: chunk?.paragraphIndex ?? null,
    charStart: chunk?.charStart ?? null,
    charEnd: chunk?.charEnd ?? null,
    sourceVerified: true,
    aiCallLogId: logId,
    promptVersionId,
  };
}

/** 摘要阶段的输入：优先用已入库的段落主旨（省 token），缺则退回原文。 */
async function summaryInputs(
  materialId: string,
  chunks: readonly ChunkRow[],
): Promise<ChunkRow[]> {
  const gists = await listByKind(materialId, 'PARAGRAPH_GIST');
  const gistByChunk = new Map<string, string>();
  for (const row of gists) {
    const gist = row.payload.gist;
    if (row.chunkId && typeof gist === 'string' && gist.trim().length > 0) {
      gistByChunk.set(row.chunkId, gist);
    }
  }
  if (gistByChunk.size === 0) return [...chunks];
  return chunks.map((chunk) => ({ ...chunk, text: gistByChunk.get(chunk.id) ?? chunk.text }));
}

/** 把疑似注入标记写回 chunk（只写标记列，不动正文）。 */
async function flagSuspicion(batch: readonly ChunkRow[]): Promise<void> {
  for (const chunk of batch) {
    const suspicion = detectInjectionSuspicion(chunk.text);
    const flags = suspicionFlagsToColumn(suspicion.markers);
    if (flags === null || flags === chunk.suspicionFlags) continue;
    await prisma.contentChunk.updateMany({
      where: { id: chunk.id },
      data: { suspicionFlags: flags },
    });
  }
}

export const analyzingStage: StageHandler = async (ctx: StageContext): Promise<StageOutcome> => {
  const { material } = ctx;

  const document = await prisma.parsedDocument.findFirst({
    where: { materialId: material.id, isCurrent: true },
    select: { id: true },
  });
  if (!document) {
    return stageFailure('analyzing', 'NO_TEXT', '找不到当前解析版本，请重试（会从解析重新开始）');
  }

  const allChunks: ChunkRow[] = await prisma.contentChunk.findMany({
    where: { parsedDocumentId: document.id },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      seq: true,
      page: true,
      paragraphIndex: true,
      text: true,
      charStart: true,
      charEnd: true,
      suspicionFlags: true,
    },
  });
  if (allChunks.length === 0) {
    return stageFailure('analyzing', 'NO_TEXT', '没有可分析的内容块，请重新解析');
  }

  /**
   * 跳过已分析过的 chunk（新一轮运行不重复花钱）。
   *
   * 判据是「这个 chunkId 已经有 `ExtractionResult`」——**被用户拒绝（rejected）的行也算
   * 已分析**：人已经裁决过了，重跑等于覆盖人的判断、还要再付一次钱。
   *
   * 这同时是成本上限的前提：总调用量由文档规模（`maxChunks / chunksPerAiCall`）决定，
   * 而不是由「用户点了几次继续」决定。
   */
  const analyzedRows = await prisma.extractionResult.findMany({
    where: { materialId: material.id, chunkId: { not: null } },
    distinct: ['chunkId'],
    select: { chunkId: true },
  });
  const analyzedChunkIds = new Set<string>();
  for (const row of analyzedRows) {
    if (row.chunkId) analyzedChunkIds.add(row.chunkId);
  }

  const chunks = allChunks.filter((chunk) => !analyzedChunkIds.has(chunk.id));
  /** 累计已分析块数（给「已分析全部 N 个」这类文案用，不能让用户看到本轮的 0）。 */
  const analyzedCount = allChunks.length - chunks.length;

  const batches = buildChunkBatches(chunks);
  const total = batches.length;
  // 只有上个 tick 已经在 analyzing 里跑过批次时，`done` 才是「已完成批数」；
  // 否则它是 normalizing 留下的 chunk 计数（`unitLabel='分块'`），不能复用。
  const alreadyDone = ctx.job.progress.unitLabel === BATCH_UNIT ? ctx.job.progress.done : 0;
  let done = Math.min(Math.max(alreadyDone, 0), total);

  const usage = emptyUsage();
  let dropped = ctx.job.progress.droppedUnverifiable ?? 0;
  let aiLimitHit = false;

  /** 单次运行的预算闸门：两个上限任一触顶就停。 */
  const budgetExhausted = (): boolean =>
    ctx.job.aiCallCount + usage.calls >= MATERIAL_LIMITS.maxAiCalls
    || ctx.job.inputTokens + usage.inputTokens >= MATERIAL_LIMITS.maxTotalInputTokens;

  /**
   * 进度。`total` 可能为 0（所有 chunk 都已分析过、只剩摘要），
   * 所以调用方**不能**用 `done / total` 算百分比（除零 → NaN）。
   */
  const progressOf = (doneCount: number) => ({
    done: doneCount,
    total,
    unitLabel: BATCH_UNIT,
    droppedUnverifiable: dropped,
  });

  const chunkTextBySeq = new Map(chunks.map((chunk) => [chunk.seq, chunk]));

  // ── 逐批抽取（本 tick 最多 aiCallsPerTick 批） ────────────────────────
  while (done < total) {
    if (usage.calls >= MATERIAL_LIMITS.aiCallsPerTick) break;
    if (Date.now() > ctx.deadline) break;
    if (budgetExhausted()) {
      aiLimitHit = true;
      break;
    }
    if (await ctx.isCancelled()) return stageCancelled(ctx);

    const batch = batches[done];
    const result = await extractChunkBatch({
      prisma,
      materialId: material.id,
      materialJobId: ctx.job.id,
      materialTitle: material.title,
      chunks: batch.map((chunk) => ({
        id: chunk.id,
        seq: chunk.seq,
        page: chunk.page,
        paragraphIndex: chunk.paragraphIndex,
        text: chunk.text,
      })),
    });

    if (!result.ok) {
      return stageFailure(
        'analyzing',
        errorCodeOf(result.code),
        `AI 分析失败：${result.message}`,
      );
    }

    await flagSuspicion(batch);

    const rows = result.items.map((item) =>
      toRow(
        material.id,
        item,
        chunkTextBySeq.get(item.source_chunk_seq),
        result.usage.logId,
        result.usage.promptVersionId,
      ),
    );
    const written = await createExtractionResults(prisma, rows);
    dropped += result.droppedUnverifiable + written.droppedUnverifiable;

    addUsage(usage, {
      calls: 1,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostUsd: result.usage.estimatedCostUsd,
    });
    done += 1;
  }

  // ── 没跑完：预算触顶转 partial，否则留在 analyzing 等下一个 tick ──────
  if (done < total) {
    const coveredChunks = batches.slice(0, done).reduce((sum, batch) => sum + batch.length, 0);
    if (aiLimitHit) {
      return {
        to: 'partial' satisfies MaterialStatus,
        stage: 'analyzing',
        progress: progressOf(done),
        statusReason: `已分析前 ${analyzedCount + coveredChunks}/${allChunks.length} 个 chunk（达到单次运行 AI 调用上限），可确认继续`,
        aiUsage: usage,
        partial: { pages: [], droppedElements: { dropped_unverifiable: dropped }, aiCallLimitHit: true },
        jobStatus: 'succeeded',
        didWork: true,
      };
    }
    return {
      to: 'analyzing',
      stage: 'analyzing',
      progress: progressOf(done),
      aiUsage: usage,
      jobStatus: 'running',
      didWork: true,
    };
  }

  // ── 全部批次数跑完 → 生成摘要 ────────────────────────────────────────
  if (budgetExhausted()) {
    return {
      to: 'partial',
      stage: 'analyzing',
      progress: progressOf(done),
      statusReason: `已分析全部 ${allChunks.length} 个 chunk，但 AI 调用已达上限，摘要未生成，可确认继续`,
      aiUsage: usage,
      partial: { pages: [], droppedElements: { dropped_unverifiable: dropped }, aiCallLimitHit: true },
      jobStatus: 'succeeded',
      didWork: true,
    };
  }

  if (await ctx.isCancelled()) return stageCancelled(ctx);

  /**
   * 摘要的输入：本轮没有剩余 chunk 时（上一轮把 chunk 都分析完、只差摘要），
   * 用**全部** chunk（优先段落主旨）来生成摘要 —— 这正是「全部 chunk 分析完但
   * 额度用完、摘要未生成」那一格的恢复路径，不能因为 `chunks` 为空就跳过摘要。
   */
  const summarySource = chunks.length > 0 ? chunks : allChunks;
  const summaryChunks = await summaryInputs(material.id, summarySource);
  const summary = await summarizeMaterial({
    prisma,
    materialId: material.id,
    materialJobId: ctx.job.id,
    materialTitle: material.title,
    chunks: summaryChunks.map((chunk) => ({
      id: chunk.id,
      seq: chunk.seq,
      page: chunk.page,
      paragraphIndex: chunk.paragraphIndex,
      text: chunk.text,
    })),
  });

  if (!summary.ok) {
    return stageFailure(
      'analyzing',
      errorCodeOf(summary.code),
      `生成摘要失败：${summary.message}`,
    );
  }

  addUsage(usage, {
    calls: 1,
    inputTokens: summary.usage.inputTokens,
    outputTokens: summary.usage.outputTokens,
    estimatedCostUsd: summary.usage.estimatedCostUsd,
  });
  dropped += summary.droppedUnverifiable;

  // 摘要只有一个 `sourceQuote` 列：取第一条通过回验的要点作整体引用。
  // 若一条都没通过回验 → **不写 SUMMARY 行**（AC-03 不允许无引用的 AI 结论入库）。
  const anchorQuote = summary.keyPoints[0]?.source_quote ?? '';
  let summaryWritten = false;
  if (anchorQuote.trim().length > 0) {
    const chunkIds = summary.keyPoints
      .map((point) => chunkTextBySeq.get(point.source_chunk_seq)?.id)
      .filter((id): id is string => typeof id === 'string');
    await upsertSummary(material.id, {
      summary: summary.summary,
      sourceChunkIds: chunkIds.length > 0 ? chunkIds : summarySource.map((chunk) => chunk.id),
      sourceQuote: anchorQuote,
      aiCallLogId: summary.usage.logId,
      promptVersionId: summary.usage.promptVersionId,
    });
    summaryWritten = true;
  }

  return {
    to: 'generating',
    stage: 'generating',
    progress: progressOf(done),
    statusReason: summaryWritten
      ? null
      : `摘要未能通过原文回验，未入库；已有 ${dropped} 条结果因内容异常被丢弃`,
    aiUsage: usage,
    jobStatus: 'running',
    didWork: true,
  };
};

/** 供测试与 UI 复用的失败文案（避免各处硬编码中文）。 */
export const ANALYZING_NO_TEXT_MESSAGE =
  MATERIAL_ERROR_MESSAGES_ZH.NO_TEXT ?? '没有可分析的有效文本';
