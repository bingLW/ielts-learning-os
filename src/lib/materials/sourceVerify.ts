/**
 * 引用回验（ADR-04 L4）：`SourceVerifier`。
 *
 * 这是整个材料分析里**最重要的一道闸**：AI 输出的任何"原文引用"都必须能在
 * 它声称的那段 chunk 里被字面找到，否则一律丢弃、不入库、并计入
 * `dropped_unverifiable`（PRD §7 会在 Analysis Review 页显示"N 条结果因内容异常
 * 未通过校验，已丢弃"）。
 *
 * 为什么归一化后比较，而不是严格逐字节：
 * - 模型常把连续空格压成一个、把全角引号换成半角、或在中文里插入零宽字符；
 *   这些都是**无语义差异**的排版噪声，不该让正确的引用被判失败。
 * - 但只允许"等价变形"：改词、换序、概括、翻译都必须失败 —— 那就不是引用了。
 */

/** 归一后短于这个长度视为不可验证（太短的一句话到处都能匹配上，等于没验）。 */
export const SOURCE_QUOTE_MIN_LENGTH = 8;

/** 零宽类字符（ADR-04 指定的三个区间 + BOM）。 */
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

/**
 * 回验用归一化（ADR-04 + NFKC）。
 *
 * 顺序有讲究：先去零宽字符（否则 NFKC 可能把零宽与邻字符合成别的形态），
 * 再 NFKC（全角/半角、兼容字符统一），最后折叠空白并小写。
 *
 * @param input 任意文本（引用或 chunk 正文）
 */
export function normalizeForVerify(input: string): string {
  return input
    .replace(ZERO_WIDTH_RE, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type SourceVerifyReason = 'not_found' | 'too_short' | 'empty';

export interface SourceVerifyResult {
  verified: boolean;
  reason?: SourceVerifyReason;
}

/**
 * 校验一条引用是否真的出自给定 chunk。
 *
 * @param quote 模型给出的原文引用
 * @param chunkText 该引用声称所属 chunk 的正文
 */
export function verifySourceQuote(quote: string, chunkText: string): SourceVerifyResult {
  const normalizedQuote = normalizeForVerify(quote ?? '');
  if (normalizedQuote.length === 0) return { verified: false, reason: 'empty' };
  if (normalizedQuote.length < SOURCE_QUOTE_MIN_LENGTH) {
    return { verified: false, reason: 'too_short' };
  }

  const normalizedChunk = normalizeForVerify(chunkText ?? '');
  if (normalizedChunk.length === 0) return { verified: false, reason: 'not_found' };
  if (!normalizedChunk.includes(normalizedQuote)) {
    return { verified: false, reason: 'not_found' };
  }
  return { verified: true };
}

/** 单条待回验项的最小形状（`ExtractionResult` 入库前必过一遍）。 */
export interface VerifiableQuote {
  source_quote: string;
  source_chunk_seq: number;
}

export interface VerifyBatchResult<T extends VerifiableQuote> {
  /** 回验通过、可以入库的项。 */
  passed: T[];
  /** 未通过的条数（`dropped_unverifiable`）。 */
  dropped: number;
  /** 未通过的明细（只留序号与原因，不留原文，避免把可疑内容再写一遍库）。 */
  droppedDetail: Array<{ seq: number; reason: SourceVerifyReason }>;
}

/**
 * 批量回验：按 `source_chunk_seq` 找到对应 chunk 再校验。
 *
 * 找不到对应序号（模型编了个不存在的 chunk 号）同样按 `not_found` 丢弃 ——
 * 这本身就是一种"引用造假"，必须计进 `dropped_unverifiable`。
 */
export function verifyQuoteBatch<T extends VerifiableQuote>(
  items: readonly T[],
  chunkTextBySeq: ReadonlyMap<number, string>,
): VerifyBatchResult<T> {
  const passed: T[] = [];
  const droppedDetail: Array<{ seq: number; reason: SourceVerifyReason }> = [];

  for (const item of items) {
    const chunkText = chunkTextBySeq.get(item.source_chunk_seq);
    if (chunkText === undefined) {
      droppedDetail.push({ seq: item.source_chunk_seq, reason: 'not_found' });
      continue;
    }
    const result = verifySourceQuote(item.source_quote, chunkText);
    if (result.verified) passed.push(item);
    else droppedDetail.push({ seq: item.source_chunk_seq, reason: result.reason ?? 'not_found' });
  }

  return { passed, dropped: droppedDetail.length, droppedDetail };
}
