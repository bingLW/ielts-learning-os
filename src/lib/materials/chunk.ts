/**
 * 分块（ADR-03：字符预算 + 句界优先 + 单句重叠）。
 *
 * 三条不可妥协的性质（单测逐条断言）：
 * 1. **绝不切断句子**（除无空格超长串的 `hard_split` 兜底，且必记 warning）；
 * 2. 每个 chunk 的 `[charStart, charEnd)` 是**新增内容的文档级绝对区间**：
 *    两两不交叠、并集覆盖原文全部有效字符；
 * 3. 相同输入两次输出逐字节相同（纯函数、无随机、无时间依赖）。
 *
 * 关于「重叠」与「不交叠」如何共存：`chunk.text` 前面会拼上一段**上文重叠**
 * （上一 chunk 的最后一句，≈`chunkOverlapChars`），但 `charStart/charEnd` 只标
 * **新增内容**的区间，重叠部分用 `textStart = charStart - overlapChars` 表达。
 * 这样 Reader 高亮/跳转用 `[charStart,charEnd)` 永远准确，而模型拿到的是带上下文
 * 的连续语篇。
 */

import { createHash } from 'node:crypto';
import { MATERIAL_CHARS_PER_TOKEN, MATERIAL_LIMITS } from '@/lib/constants';
import type { MaterialChunkKind } from '@/lib/constants';
import type { ParsedParagraph } from './parsers/types';

/** 常见缩写：其后的句点不算句子结束（ADR-03 明确点名 Mr./e.g./U.S.）。 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'mrs',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'eg',
  'ie',
  'cf',
  'al',
  'fig',
  'figs',
  'no',
  'nos',
  'vol',
  'chap',
  'sec',
  'art',
  'para',
  'pp',
  'inc',
  'ltd',
  'co',
  'corp',
  'dept',
  'univ',
  'est',
  'approx',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'am',
  'pm',
  'a.m',
  'p.m',
  'u.s',
  'u.k',
  'e.g',
  'i.e',
]);

/**
 * 句末标点（ASCII）：`.` 需要额外处理缩写；其余一律算边界。
 *
 * 注意这些标点**必须**后面跟空白才算句界，否则 `v2.6` / `a;b` / URL 会被切碎。
 */
const FULL_STOPS = new Set(['.', '!', '?', ';']);
/**
 * 中日文句末标点：中文材料不需要空格分隔，遇到即断句。
 *
 * 如果没有这一组，「第一句。第二句。」会被当成一句 —— 中文材料的分块就直接
 * 退化成「整篇一个 chunk」，句界优先（ADR-03）形同失效。
 */
const CJK_FULL_STOPS = new Set(['。', '！', '？', '；', '…']);
/** 可以紧跟句末标点、仍然属于本句的收尾字符。 */
const TRAILING_CHARS = new Set(['"', "'", '”', '’', ')', ']', '}', '》', '」', '』']);

/** 判断 `text[periodIndex]` 处的句点是否属于缩写（不构成句子边界）。 */
function isAbbreviationPeriod(text: string, periodIndex: number): boolean {
  const window = text.slice(Math.max(0, periodIndex - 20), periodIndex);
  const match = /([A-Za-z][A-Za-z.]*)$/.exec(window);
  if (!match) return false;
  const token = match[1];
  // 单字母大写（人名首字母 J. K. Rowling）或带内点的缩写（e.g. / U.S.）
  if (token.length === 1 && /[A-Z]/.test(token)) return true;
  if (token.includes('.')) return true;
  return ABBREVIATIONS.has(token.toLowerCase());
}

export interface SentenceRange {
  start: number;
  end: number;
}

/**
 * 把一段文本切成句子区间（连续、覆盖全部非空白字符，不含首尾空白）。
 *
 * 只做「够用」的句界判断：句末标点 + （下一字符是空白或结尾）、排除缩写。
 * 不引入 NLP 模型 —— 分块只需要稳定、可解释、可单测的边界。
 */
export function splitSentenceRanges(text: string): SentenceRange[] {
  const ranges: SentenceRange[] = [];
  let start = 0;
  let index = 0;

  const pushRange = (endExclusive: number): void => {
    let from = start;
    let to = endExclusive;
    while (from < to && /\s/.test(text[from])) from += 1;
    while (to > from && /\s/.test(text[to - 1])) to -= 1;
    if (to > from) ranges.push({ start: from, end: to });
    // 下一句从 endExclusive 开始（跳过空白由 pushRange 负责）
    start = endExclusive;
  };

  while (index < text.length) {
    const char = text[index];
    const cjkStop = CJK_FULL_STOPS.has(char);
    if (!cjkStop && !FULL_STOPS.has(char)) {
      index += 1;
      continue;
    }
    if (char === '.' && isAbbreviationPeriod(text, index)) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < text.length && TRAILING_CHARS.has(text[end])) end += 1;
    const next = text[end];
    // 中日文标点：无需后置空白；ASCII 标点：必须后置空白或已到文末
    if (cjkStop || next === undefined || /\s/.test(next)) {
      pushRange(end);
      index = end;
      continue;
    }
    index += 1;
  }

  pushRange(text.length);
  return ranges;
}

export interface ChunkDraft {
  /** 1 起单调递增。 */
  seq: number;
  kind: MaterialChunkKind;
  headingPath: string | null;
  page: number | null;
  paragraphIndex: number | null;
  /** 新增内容的绝对起止（Reader 高亮 / SourceVerifier 定位用）。 */
  charStart: number;
  charEnd: number;
  /** 含重叠前缀后的实际文本起点（`charStart - overlapChars`）。 */
  textStart: number;
  /** 含重叠前缀的最终文本（喂给模型的就是它）。 */
  text: string;
  textHash: string;
  charCount: number;
  estTokens: number;
  /** 本次为拼接上文重叠而额外带上的字符数。 */
  overlapChars: number;
  warnings: string[];
}

export interface ChunkOptions {
  /** 目标字符数（到量即在句界处收口）。 */
  targetChars?: number;
  /** 单 chunk 硬上限（不得跨越）。 */
  maxChars?: number;
  /** 重叠字符数（取上一 chunk 末句）。 */
  overlapChars?: number;
  /** 单材料 chunk 上限。 */
  maxChunks?: number;
}

export interface ChunkResult {
  chunks: ChunkDraft[];
  /** 是否因 `maxChunks` 截断（材料应落 partial + reason=chunk_limit）。 */
  truncated: boolean;
  /** hard_split 次数（>0 时该材料应带 warning）。 */
  hardSplits: number;
  warnings: string[];
}

interface SentenceUnit extends SentenceRange {
  page: number | null;
  paragraphIndex: number;
  paragraphKind: MaterialChunkKind;
  headingLevel: number | null;
  headingPath: string | null;
}

/** 计算文档级标题路径（如 `Chapter 2 > 2.1 Vocabulary`）。 */
function buildHeadingPaths(paragraphs: readonly ParsedParagraph[]): Array<string | null> {
  const stack: Array<{ level: number; text: string }> = [];
  const paths: Array<string | null> = [];
  for (const paragraph of paragraphs) {
    if (paragraph.headingLevel) {
      while (stack.length > 0 && stack[stack.length - 1].level >= paragraph.headingLevel) {
        stack.pop();
      }
      stack.push({ level: paragraph.headingLevel, text: paragraph.text });
    }
    paths.push(stack.length > 0 ? stack.map((item) => item.text).join(' > ') : null);
  }
  return paths;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / MATERIAL_CHARS_PER_TOKEN.en);
}

/** 取上一 chunk 的「最后一句」作为重叠；过长则退到 `overlapChars` 并对齐空格。 */
export function computeOverlap(previousText: string, overlapChars: number): string {
  if (!previousText || overlapChars <= 0) return '';
  const ranges = splitSentenceRanges(previousText);
  const last = ranges.at(-1);
  if (last) {
    const sentence = previousText.slice(last.start, last.end);
    if (sentence.length <= overlapChars) return sentence;
  }
  let tail = previousText.slice(-overlapChars);
  const space = tail.indexOf(' ');
  if (space >= 0) tail = tail.slice(space + 1);
  return tail.trim();
}

/** 在 `[start, start+maxChars)` 内找最近的空格切点（找不到就硬切）。 */
function findHardCut(docText: string, start: number, maxChars: number): number {
  const limit = Math.min(docText.length, start + maxChars);
  for (let i = limit; i > start; i -= 1) {
    if (/\s/.test(docText[i - 1])) return i - 1 > start ? i - 1 : limit;
  }
  return limit;
}

/**
 * 主入口：把段落切成 chunk。
 *
 * @param paragraphs `assembleParagraphs` 的产物（`charStart/charEnd` 必须连续）
 */
export function chunkParagraphs(
  paragraphs: readonly ParsedParagraph[],
  options: ChunkOptions = {},
): ChunkResult {
  const targetChars = options.targetChars ?? MATERIAL_LIMITS.chunkTargetChars;
  const maxChars = options.maxChars ?? MATERIAL_LIMITS.chunkMaxChars;
  const overlapChars = options.overlapChars ?? MATERIAL_LIMITS.chunkOverlapChars;
  const maxChunks = options.maxChunks ?? MATERIAL_LIMITS.maxChunks;

  const docText = paragraphs.map((paragraph) => paragraph.text).join('\n\n');
  const headingPaths = buildHeadingPaths(paragraphs);

  // 1) 展开成句级单元（保持文档顺序与绝对偏移）
  const units: SentenceUnit[] = [];
  paragraphs.forEach((paragraph, index) => {
    for (const range of splitSentenceRanges(paragraph.text)) {
      units.push({
        start: paragraph.charStart + range.start,
        end: paragraph.charStart + range.end,
        page: paragraph.page,
        paragraphIndex: paragraph.paragraphIndex,
        paragraphKind: paragraph.kind,
        headingLevel: paragraph.headingLevel,
        headingPath: headingPaths[index] ?? null,
      });
    }
  });

  const chunks: ChunkDraft[] = [];
  const warnings: string[] = [];
  let hardSplits = 0;
  let truncated = false;

  let pending: { start: number; end: number; unitStart: number; unitEnd: number } | null = null;
  let previousCoreText = '';

  const flush = (): void => {
    if (!pending) return;
    if (chunks.length >= maxChunks) {
      truncated = true;
      pending = null;
      return;
    }
    const { start, end, unitStart, unitEnd } = pending;
    const unitSlice = units.slice(unitStart, unitEnd + 1);
    const firstUnit = unitSlice[0];
    const coreText = docText.slice(start, end);
    const overlap = chunks.length > 0 ? computeOverlap(previousCoreText, overlapChars) : '';
    const text = overlap ? `${overlap}${coreText}` : coreText;

    const kinds = new Set(unitSlice.map((unit) => unit.paragraphKind));
    const kind: MaterialChunkKind =
      kinds.size === 1 ? (unitSlice[0].paragraphKind as MaterialChunkKind) : 'MIXED';
    const chunkWarnings = unitSlice.some((unit) => unit.headingLevel !== null && unit.headingLevel <= 2)
      ? ['starts_at_heading']
      : [];

    chunks.push({
      seq: chunks.length + 1,
      kind,
      headingPath: firstUnit.headingPath,
      page: firstUnit.page,
      paragraphIndex: firstUnit.paragraphIndex,
      charStart: start,
      charEnd: end,
      textStart: start - overlap.length,
      text,
      textHash: hashText(text),
      charCount: text.length,
      estTokens: estimateTokens(text.length),
      overlapChars: overlap.length,
      warnings: chunkWarnings,
    });

    previousCoreText = coreText;
    pending = null;
  };

  // 2) 贪心装句：句界处收口，句内不切
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];

    // 一级/二级标题强制开新块（章节边界）
    if (unit.headingLevel !== null && unit.headingLevel <= 2) flush();

    if (unit.end - unit.start > maxChars) {
      // 超长「句」：先收口，再按空格优先硬切（并记 warning）
      flush();
      let cursor = unit.start;
      while (cursor < unit.end) {
        const cut = findHardCut(docText, cursor, maxChars);
        const pieceStart = cursor;
        const pieceEnd = Math.min(cut, unit.end);
        if (chunks.length >= maxChunks) {
          truncated = true;
          break;
        }
        const coreText = docText.slice(pieceStart, pieceEnd);
        const overlap = chunks.length > 0 ? computeOverlap(previousCoreText, overlapChars) : '';
        const text = overlap ? `${overlap}${coreText}` : coreText;
        hardSplits += 1;
        chunks.push({
          seq: chunks.length + 1,
          kind: unit.paragraphKind,
          headingPath: unit.headingPath,
          page: unit.page,
          paragraphIndex: unit.paragraphIndex,
          charStart: pieceStart,
          charEnd: pieceEnd,
          textStart: pieceStart - overlap.length,
          text,
          textHash: hashText(text),
          charCount: text.length,
          estTokens: estimateTokens(text.length),
          overlapChars: overlap.length,
          warnings: ['hard_split'],
        });
        previousCoreText = coreText;
        cursor = pieceEnd;
      }
      continue;
    }

    if (!pending) {
      pending = { start: unit.start, end: unit.end, unitStart: index, unitEnd: index };
    } else if (unit.end - pending.start <= maxChars) {
      pending.end = unit.end;
      pending.unitEnd = index;
    } else {
      flush();
      pending = { start: unit.start, end: unit.end, unitStart: index, unitEnd: index };
    }

    if (pending && pending.end - pending.start >= targetChars) flush();
  }
  flush();

  if (truncated) {
    warnings.push(`chunk_limit: 内容超过 ${maxChunks} 个分块，仅处理前面的部分`);
  }
  if (hardSplits > 0) {
    warnings.push(`hard_split: ${hardSplits} 处因没有空格断点被强制切分`);
  }
  if (units.length === 0) warnings.push('empty_document: 没有可切分的文本');

  return { chunks, truncated, hardSplits, warnings };
}
