/**
 * AI 提取结果仓储（T09）。
 *
 * 唯一职责：把「回验通过的抽取结果」写进 `ExtractionResult`，并保证一条铁律 ——
 * **`sourceVerified !== true` 的行不可能被写进去**（G1 / AC-03）。
 *
 * 这条铁律写在仓储层而不是调用方，是因为调用方有好几处（analyzing 阶段、
 * 后续的练习题/词汇候选派生）。放在这里，漏调一次 `verifySourceQuote` 也进不了库；
 * 未被拦下的部分会以 `droppedUnverifiable` 计数返回，UI 才有"N 条已丢弃"可显示。
 *
 * 刻意**不提供** update：`payloadJson` 是 AI 的原始输出，用户编辑走
 * `editedPayloadJson`（由审阅流程写），两者物理分开，可追溯（§2.6）。
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { parseJson, stringify } from '@/lib/json';
import { prisma as defaultPrisma } from '@/lib/prisma';

/** 允许在事务内或事务外调用（阶段处理器可能不开显式事务）。 */
export type ExtractionDb = PrismaClient | Prisma.TransactionClient;

/** `ExtractionResult.kind` 的取值（与 §2.6 注释一致）。 */
export const EXTRACTION_KINDS = [
  'KEYWORD',
  'COLLOCATION',
  'KEY_SENTENCE',
  'PARAGRAPH_GIST',
  'GRAMMAR_POINT',
  'SUMMARY',
  'TOPIC',
] as const;
export type ExtractionKind = (typeof EXTRACTION_KINDS)[number];

/** 一条待写入的提取结果。 */
export interface ExtractionRowInput {
  materialId: string;
  /** chunk 级必填；SUMMARY/TOPIC 为 null。 */
  chunkId?: string | null;
  kind: ExtractionKind;
  /** zod 校验后的结构化对象（snake_case 原样保留）。 */
  payload: unknown;
  /** 原文引用；空串或缺失视为不可入库。 */
  sourceQuote: string;
  /** SUMMARY 依赖哪些 chunk。 */
  sourceChunkIds?: readonly string[];
  page?: number | null;
  paragraphIndex?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
  /** 回验结论；**只有 true 会被写入**。 */
  sourceVerified: boolean;
  aiCallLogId?: string | null;
  promptVersionId?: string | null;
}

export interface CreateExtractionResultsSummary {
  /** 真正写入的行数。 */
  created: number;
  /** 因未通过回验（或引用为空）被丢弃的行数（`dropped_unverifiable`）。 */
  droppedUnverifiable: number;
}

/**
 * 批量写入提取结果（只写通过回验的行）。
 *
 * @param db Prisma 客户端或事务客户端
 * @param items 待写入行
 */
export async function createExtractionResults(
  db: ExtractionDb,
  items: readonly ExtractionRowInput[],
): Promise<CreateExtractionResultsSummary> {
  const acceptable = items.filter(
    (item) => item.sourceVerified === true && item.sourceQuote.trim().length > 0,
  );
  const droppedUnverifiable = items.length - acceptable.length;

  if (acceptable.length === 0) return { created: 0, droppedUnverifiable };

  await db.extractionResult.createMany({
    data: acceptable.map((item) => ({
      materialId: item.materialId,
      chunkId: item.chunkId ?? null,
      kind: item.kind,
      // payloadJson 是 NOT NULL 列：序列化失败也不能写 null，退化成空对象
      payloadJson: stringify(item.payload) ?? '{}',
      sourceQuote: item.sourceQuote,
      sourceChunkIdsJson: item.sourceChunkIds ? stringify(item.sourceChunkIds) : null,
      page: item.page ?? null,
      paragraphIndex: item.paragraphIndex ?? null,
      charStart: item.charStart ?? null,
      charEnd: item.charEnd ?? null,
      sourceVerified: true,
      isDerived: true,
      aiCallLogId: item.aiCallLogId ?? null,
      promptVersionId: item.promptVersionId ?? null,
      reviewStatus: 'draft',
    })),
  });

  return { created: acceptable.length, droppedUnverifiable };
}

/** 读回时的形状（payload 已解析）。 */
export interface ExtractionRowDto {
  id: string;
  kind: string;
  chunkId: string | null;
  payload: Record<string, unknown>;
  sourceQuote: string;
  sourceChunkIds: string[];
  page: number | null;
  paragraphIndex: number | null;
  charStart: number | null;
  charEnd: number | null;
  reviewStatus: string;
  createdAt: Date;
}

function toRowDto(row: {
  id: string;
  kind: string;
  chunkId: string | null;
  payloadJson: string;
  sourceQuote: string;
  sourceChunkIdsJson: string | null;
  page: number | null;
  paragraphIndex: number | null;
  charStart: number | null;
  charEnd: number | null;
  reviewStatus: string;
  createdAt: Date;
}): ExtractionRowDto {
  return {
    id: row.id,
    kind: row.kind,
    chunkId: row.chunkId,
    payload: parseJson<Record<string, unknown>>(row.payloadJson, {}) ?? {},
    sourceQuote: row.sourceQuote,
    sourceChunkIds: parseJson<string[]>(row.sourceChunkIdsJson, []) ?? [],
    page: row.page,
    paragraphIndex: row.paragraphIndex,
    charStart: row.charStart,
    charEnd: row.charEnd,
    reviewStatus: row.reviewStatus,
    createdAt: row.createdAt,
  };
}

/**
 * 按 kind 列出某材料已入库的提取结果（默认只返回仍为 draft 的行）。
 *
 * @param materialId 材料 id
 * @param kind 种别
 * @param options 可指定 `reviewStatus` 与上限
 */
export async function listByKind(
  materialId: string,
  kind: ExtractionKind,
  options: { reviewStatus?: string; take?: number; db?: ExtractionDb } = {},
): Promise<ExtractionRowDto[]> {
  const db = options.db ?? defaultPrisma;
  const rows = await db.extractionResult.findMany({
    where: {
      materialId,
      kind,
      ...(options.reviewStatus ? { reviewStatus: options.reviewStatus } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    ...(options.take ? { take: options.take } : {}),
  });
  return rows.map(toRowDto);
}

/**
 * 写一条材料摘要（`kind='SUMMARY'`）。
 *
 * `ExtractionResult` 没有 `superseded` 字段，所以重生成时**追加**一条新记录，
 * 读取端用 `getLatestSummary()` 取最新 —— 旧摘要保留可追溯，不覆盖 AI 原始输出。
 *
 * @returns 新记录 id
 */
export async function upsertSummary(
  materialId: string,
  payload: {
    /** 摘要正文（写进 payload 的 `summary_zh`）。 */
    summary: unknown;
    /** 参与摘要的 chunk id（写入 `sourceChunkIdsJson`）。 */
    sourceChunkIds: readonly string[];
    /** 摘要的整体引用（取第一条通过回验的要点的原文）。 */
    sourceQuote: string;
    aiCallLogId?: string | null;
    promptVersionId?: string | null;
    db?: ExtractionDb;
  },
): Promise<string> {
  const db = payload.db ?? defaultPrisma;
  const row = await db.extractionResult.create({
    data: {
      materialId,
      chunkId: null,
      kind: 'SUMMARY',
      payloadJson: stringify(payload.summary) ?? '{}',
      sourceQuote: payload.sourceQuote,
      sourceChunkIdsJson: stringify(payload.sourceChunkIds),
      sourceVerified: true,
      isDerived: true,
      aiCallLogId: payload.aiCallLogId ?? null,
      promptVersionId: payload.promptVersionId ?? null,
      reviewStatus: 'draft',
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * 取最新的材料摘要（重生成会追加，这里按创建时间倒序取第一条）。
 *
 * @param materialId 材料 id
 */
export async function getLatestSummary(
  materialId: string,
  db: ExtractionDb = defaultPrisma,
): Promise<ExtractionRowDto | null> {
  const row = await db.extractionResult.findFirst({
    where: { materialId, kind: 'SUMMARY' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return row ? toRowDto(row) : null;
}
