/**
 * 段落装配器：把解析器产出的「块」变成带绝对偏移的 `ParsedParagraph[]`。
 *
 * 这是全文偏移的唯一来源：`text = blocks.join('\n\n')`，每个段落的
 * `[charStart, charEnd)` 都指向这个 `text`，因此
 *
 *   - 段落区间两两不交叠；
 *   - `charEnd - charStart === paragraph.text.length`；
 *   - 段落之间的空隙正好是两个换行符。
 *
 * 分块阶段（`chunk.ts`）的「并集覆盖且不交叠」断言，就是建立在
 * 「段落区间先满足这个性质」之上的。
 */

import type { MaterialChunkKind } from '@/lib/constants';
import { countWords } from './displayName';
import type { ParsedParagraph } from './parsers/types';

/** 段落分隔符（也是 `charStart` 递增时的空隙来源）。 */
export const PARAGRAPH_SEPARATOR = '\n\n';

/** 解析器交给装配器的原始块。 */
export interface RawBlock {
  text: string;
  headingLevel?: number | null;
  page?: number | null;
  kind?: MaterialChunkKind;
}

export interface AssembledDocument {
  paragraphs: ParsedParagraph[];
  text: string;
  charCount: number;
  wordCount: number;
}

/** 文本规范化：统一换行、去行尾空白、折叠 3+ 空行、去首尾空白。 */
export function normalizeBlockText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 装配段落与全文。
 *
 * @param blocks 解析器按文档顺序给出的块（空块会被自动丢弃）
 */
export function assembleParagraphs(blocks: readonly RawBlock[]): AssembledDocument {
  const paragraphs: ParsedParagraph[] = [];
  let cursor = 0;

  for (const block of blocks) {
    const text = normalizeBlockText(block.text);
    if (text.length === 0) continue;
    const headingLevel =
      typeof block.headingLevel === 'number' && block.headingLevel >= 1 && block.headingLevel <= 6
        ? Math.floor(block.headingLevel)
        : null;
    const kind: MaterialChunkKind =
      block.kind ?? (headingLevel ? 'HEADING' : 'PARAGRAPH');
    const charStart = cursor;
    const charEnd = charStart + text.length;
    paragraphs.push({
      text,
      page: block.page ?? null,
      paragraphIndex: paragraphs.length + 1,
      charStart,
      charEnd,
      headingLevel,
      kind,
    });
    cursor = charEnd + PARAGRAPH_SEPARATOR.length;
  }

  const text = paragraphs.map((paragraph) => paragraph.text).join(PARAGRAPH_SEPARATOR);
  return {
    paragraphs,
    text,
    charCount: text.length,
    wordCount: countWords(text),
  };
}
