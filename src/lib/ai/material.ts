/**
 * 材料域 AI 入口（ADR-06）。
 *
 * 这一层刻意**很薄**：provider、重试、预算、记账全在 `runAiCompletion()` 里，
 * 这里只做四件事 —— ① 构造 `AiPromptMeta`；② `wrapMaterialData()` 把不可信正文
 * 包成带 nonce 的 data 区块；③ 调 `runAiCompletion()`；④ 用 `SourceVerifier`
 * 把不是原文的引用**丢掉**。
 *
 * 第 ④ 步是 AC-03 的落点：**没有 `sourceVerified=true` 的结果不许入库**。
 * 「丢了就丢了」比「留着一条看起来对、其实模型编的引用」安全得多。
 */

import type { PrismaClient } from '@prisma/client';
import type {
  MaterialExerciseItem,
  MaterialExtractItem,
  MaterialSummaryResult,
} from './structured';
import {
  runAiCompletion,
  type AiCompletionOutcome,
  type RunAiCompletionInput,
} from './orchestrator';
import type { AiCallStatus, AiPromptMeta, AiTurnFailureCode } from './types';
import {
  detectInjectionSuspicion,
  wrapMaterialData,
  type WrapMaterialDataResult,
} from '@/lib/materials/injection';
import {
  verifyQuoteBatch,
  type SourceVerifyReason,
} from '@/lib/materials/sourceVerify';

/** 材料域默认的教练模式/技能（材料分析不是"对话"，这两个字段只用于日志与提示词渲染）。 */
const MATERIAL_PROMPT_MODE = 'TUTOR' as const;
const MATERIAL_PROMPT_SKILL = 'READING' as const;

/** 送进 AI 的 chunk 形状（只带必要字段，避免把 DB 模型泄漏进 prompt 层）。 */
export interface AiMaterialChunk {
  id: string;
  seq: number;
  page: number | null;
  paragraphIndex: number | null;
  text: string;
}

/** 一次材料 AI 调用的计量（累加进 `ProcessingJob`）。 */
export interface MaterialAiUsage {
  status: AiCallStatus;
  logId: string;
  requestId: string;
  promptVersionId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
}

/** 失败形状：与 `AiCompletionOutcome` 的失败分支一致，便于上抛到阶段层。 */
export interface MaterialAiFailure {
  ok: false;
  code: AiTurnFailureCode;
  message: string;
  logId?: string;
}

/** 调用共用的公共入参。 */
export interface MaterialAiBaseInput {
  prisma: PrismaClient;
  materialId: string;
  materialJobId: string;
  materialTitle: string;
  /** 学习者等级（缺省 B1）；只用于提示词措辞，不参与任何判定。 */
  learnerLevel?: string;
}

/** 回验丢弃的明细（只留序号与原因，不把可疑原文再写一遍库）。 */
export interface DroppedVerifyDetail {
  seq: number;
  reason: SourceVerifyReason;
}

function usageOf(outcome: Extract<AiCompletionOutcome, { ok: true }>): MaterialAiUsage {
  return {
    status: outcome.status,
    logId: outcome.logId,
    requestId: outcome.requestId,
    promptVersionId: outcome.promptVersionId,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    estimatedCostUsd: outcome.estimatedCostUsd,
    latencyMs: outcome.latencyMs,
  };
}

function failureOf(outcome: Extract<AiCompletionOutcome, { ok: false }>): MaterialAiFailure {
  return {
    ok: false,
    code: outcome.code,
    message: outcome.message,
    ...(outcome.logId ? { logId: outcome.logId } : {}),
  };
}

/**
 * 材料域 meta 的公共部分（`materialChunksBlock` 只接受 `wrapMaterialData` 的产物）。
 *
 * `chunkHint` 会写进 `meta.baseline`，**只为 mock 通道服务**：`MockProvider` 用
 * `meta.baseline` 造引文，不喂真实正文它就会编一句 "The quick brown fox…"，
 * 于是每条都被回验丢掉、测试没法验证"通过路径"。材料模板全程不渲染
 * `{{baseline}}`（见 `renderPrompt`），所以真实提示词内容零变化。
 */
function baseMeta(
  input: MaterialAiBaseInput,
  wrapped: WrapMaterialDataResult,
  chunkHint?: string,
): AiPromptMeta {
  const hint = chunkHint?.slice(0, 2000);
  return {
    mode: MATERIAL_PROMPT_MODE,
    skill: MATERIAL_PROMPT_SKILL,
    objective: `分析学习材料：${input.materialTitle}`,
    targetLevel: input.learnerLevel ?? 'B1',
    ...(hint ? { baseline: hint } : {}),
    materialTitle: input.materialTitle,
    materialChunksBlock: wrapped.block,
    materialSkillTarget: 'READING',
    learnerLevel: input.learnerLevel ?? 'B1',
  };
}

/** 调 `runAiCompletion` 并带上材料归属（C-08：确保 `AICallLog.materialId` 非空）。 */
async function complete(
  input: MaterialAiBaseInput,
  promptKind: RunAiCompletionInput['promptKind'],
  meta: AiPromptMeta,
): Promise<AiCompletionOutcome> {
  return runAiCompletion({
    prisma: input.prisma,
    promptKind,
    meta,
    attribution: { materialId: input.materialId, materialJobId: input.materialJobId },
  });
}

// ── ① 单批 chunk 抽取 ──────────────────────────────────────────────────

export interface ExtractChunkBatchInput extends MaterialAiBaseInput {
  chunks: readonly AiMaterialChunk[];
  /** 允许的抽取类型（逗号串，如 `KEYWORD,COLLOCATION`）。 */
  allowedKinds?: string;
}

export interface ExtractChunkBatchSuccess {
  ok: true;
  /** **只包含回验通过的条目**（AC-03）。 */
  items: MaterialExtractItem[];
  droppedUnverifiable: number;
  droppedDetail: DroppedVerifyDetail[];
  batchNote?: string;
  nonce: string;
  markerCollisions: number;
  truncation?: { droppedChunks: number };
  usage: MaterialAiUsage;
}

export type ExtractChunkBatchResult = ExtractChunkBatchSuccess | MaterialAiFailure;

const DEFAULT_EXTRACT_KINDS = 'KEYWORD,COLLOCATION,KEY_SENTENCE,PARAGRAPH_GIST,GRAMMAR_POINT';

/**
 * 抽取一批 chunk 的可核查条目。
 *
 * @param input 见 `ExtractChunkBatchInput`
 */
export async function extractChunkBatch(
  input: ExtractChunkBatchInput,
): Promise<ExtractChunkBatchResult> {
  const wrapped = wrapMaterialData({
    chunks: input.chunks.map((chunk) => ({
      seq: chunk.seq,
      page: chunk.page,
      paragraphIndex: chunk.paragraphIndex,
      text: chunk.text,
    })),
    title: input.materialTitle,
  });

  const meta: AiPromptMeta = {
    ...baseMeta(input, wrapped, input.chunks[0]?.text),
    allowedKinds: input.allowedKinds ?? DEFAULT_EXTRACT_KINDS,
  };

  const outcome = await complete(input, 'material_extract', meta);
  if (!outcome.ok) return failureOf(outcome);

  const data = outcome.structured as { items: MaterialExtractItem[]; batch_note?: string };
  const chunkTextBySeq = new Map(input.chunks.map((chunk) => [chunk.seq, chunk.text]));
  const verified = verifyQuoteBatch(data.items, chunkTextBySeq);

  return {
    ok: true,
    items: verified.passed,
    droppedUnverifiable: verified.dropped,
    droppedDetail: verified.droppedDetail,
    ...(data.batch_note ? { batchNote: data.batch_note } : {}),
    nonce: wrapped.nonce,
    markerCollisions: wrapped.markerCollisions,
    ...(wrapped.truncation ? { truncation: wrapped.truncation } : {}),
    usage: usageOf(outcome),
  };
}

// ── ② 全材料摘要 ──────────────────────────────────────────────────────

export interface SummarizeMaterialInput extends MaterialAiBaseInput {
  /** 参与摘要的 chunk（长材料建议传 chunk 主旨拼成的精简文本）。 */
  chunks: readonly AiMaterialChunk[];
}

export interface SummarizeMaterialSuccess {
  ok: true;
  summary: MaterialSummaryResult;
  /** 回验通过的要点（未通过的不进 `summary.key_points`）。 */
  keyPoints: MaterialSummaryResult['key_points'];
  droppedUnverifiable: number;
  droppedDetail: DroppedVerifyDetail[];
  nonce: string;
  markerCollisions: number;
  truncation?: { droppedChunks: number };
  usage: MaterialAiUsage;
}

export type SummarizeMaterialResult = SummarizeMaterialSuccess | MaterialAiFailure;

/**
 * 生成全材料摘要（要点必须能回验，AC-03）。
 *
 * @param input 见 `SummarizeMaterialInput`
 */
export async function summarizeMaterial(
  input: SummarizeMaterialInput,
): Promise<SummarizeMaterialResult> {
  const wrapped = wrapMaterialData({
    chunks: input.chunks.map((chunk) => ({
      seq: chunk.seq,
      page: chunk.page,
      paragraphIndex: chunk.paragraphIndex,
      text: chunk.text,
    })),
    title: input.materialTitle,
  });

  const outcome = await complete(input, 'material_summary', baseMeta(input, wrapped, input.chunks[0]?.text));
  if (!outcome.ok) return failureOf(outcome);

  const data = outcome.structured as MaterialSummaryResult;
  const chunkTextBySeq = new Map(input.chunks.map((chunk) => [chunk.seq, chunk.text]));
  const verified = verifyQuoteBatch(data.key_points, chunkTextBySeq);

  return {
    ok: true,
    // key_points 换成"只留回验通过的"版本，其余字段原样
    summary: { ...data, key_points: verified.passed },
    keyPoints: verified.passed,
    droppedUnverifiable: verified.dropped,
    droppedDetail: verified.droppedDetail,
    nonce: wrapped.nonce,
    markerCollisions: wrapped.markerCollisions,
    ...(wrapped.truncation ? { truncation: wrapped.truncation } : {}),
    usage: usageOf(outcome),
  };
}

// ── ③ 客观题生成 ──────────────────────────────────────────────────────

export interface GenerateExercisesInput extends MaterialAiBaseInput {
  chunks: readonly AiMaterialChunk[];
  /** 题型要求（逗号串，如 `reading_gist,vocab_in_context`）。 */
  exerciseTypes: string;
  /** 本批题量上限。 */
  questionBudget: number;
}

export interface GenerateExercisesSuccess {
  ok: true;
  /** **只包含依据可回验的题**（题的依据是 `evidence_quote`）。 */
  exercises: MaterialExerciseItem[];
  droppedUnverifiable: number;
  droppedDetail: DroppedVerifyDetail[];
  nonce: string;
  markerCollisions: number;
  usage: MaterialAiUsage;
}

export type GenerateExercisesResult = GenerateExercisesSuccess | MaterialAiFailure;

/**
 * 生成一批客观题（每题必须带可回验的 `evidence_quote`）。
 *
 * 注意：本批只提供**调用函数**；练习集落库（`MaterialExerciseSet`/`GeneratedExercise`）
 * 与 `generating` 阶段属 T11。
 *
 * @param input 见 `GenerateExercisesInput`
 */
export async function generateExercises(
  input: GenerateExercisesInput,
): Promise<GenerateExercisesResult> {
  const wrapped = wrapMaterialData({
    chunks: input.chunks.map((chunk) => ({
      seq: chunk.seq,
      page: chunk.page,
      paragraphIndex: chunk.paragraphIndex,
      text: chunk.text,
    })),
    title: input.materialTitle,
  });

  const meta: AiPromptMeta = {
    ...baseMeta(input, wrapped, input.chunks[0]?.text),
    exerciseTypes: input.exerciseTypes,
    questionBudget: input.questionBudget,
  };

  const outcome = await complete(input, 'material_exercise', meta);
  if (!outcome.ok) return failureOf(outcome);

  const data = outcome.structured as { exercises: MaterialExerciseItem[] };
  const chunkTextBySeq = new Map(input.chunks.map((chunk) => [chunk.seq, chunk.text]));
  // 题目把引用放在 evidence_quote 里，先映射成统一的 source_quote 再回验
  const normalized = data.exercises.map((item) => ({
    ...item,
    source_quote: item.evidence_quote,
  }));
  const verified = verifyQuoteBatch(normalized, chunkTextBySeq);

  return {
    ok: true,
    exercises: verified.passed.map(({ source_quote: _sourceQuote, ...rest }) => rest),
    droppedUnverifiable: verified.dropped,
    droppedDetail: verified.droppedDetail,
    nonce: wrapped.nonce,
    markerCollisions: wrapped.markerCollisions,
    usage: usageOf(outcome),
  };
}

// ── ④ 词汇模式速查（复用 material_extract，只取词汇/搭配） ──────────────

export interface GlossChunkInput extends MaterialAiBaseInput {
  chunk: AiMaterialChunk;
}

export interface GlossChunkSuccess {
  ok: true;
  items: MaterialExtractItem[];
  droppedUnverifiable: number;
  droppedDetail: DroppedVerifyDetail[];
  /** 命中注入疑似模式的标记（只提示，不改变结果）。 */
  suspicionFlags: string[];
  usage: MaterialAiUsage;
}

export type GlossChunkResult = GlossChunkSuccess | MaterialAiFailure;

/**
 * 词汇模式的单 chunk 速查（Reader 侧边栏用）。
 *
 * 没有独立的 prompt kind：直接复用 `material_extract` 并把 `allowedKinds` 收窄到
 * `KEYWORD,COLLOCATION`，避免为同一份正文再维护一套提示词与 schema。
 *
 * @param input 见 `GlossChunkInput`
 */
export async function glossChunkForVocabMode(
  input: GlossChunkInput,
): Promise<GlossChunkResult> {
  const suspicion = detectInjectionSuspicion(input.chunk.text);
  const batch = await extractChunkBatch({
    ...input,
    chunks: [input.chunk],
    allowedKinds: 'KEYWORD,COLLOCATION',
  });
  if (!batch.ok) return batch;
  return {
    ok: true,
    items: batch.items,
    droppedUnverifiable: batch.droppedUnverifiable,
    droppedDetail: batch.droppedDetail,
    suspicionFlags: suspicion.markers,
    usage: batch.usage,
  };
}
