/**
 * 纯文本解析器（ADR-02：零依赖）。
 *
 * 段落边界口径：**空行**是段落分隔符；单换行在段落内部保留为软换行。
 * 唯一例外：若一个空行段落超过 `chunkMaxChars` 且内部有单换行（典型是
 * 「每行一句」的歌词/字幕/OCR 输出），则按单换行再切一层 —— 否则会生成
 * 远超上限的巨型段落，让分块阶段只能 `hard_split`。
 */

import { MATERIAL_LIMITS } from '@/lib/constants';
import { assembleParagraphs, normalizeBlockText, type RawBlock } from '../paragraphs';
import type { MaterialParser, MaterialParserInput, ParseResult } from './types';

/** 去掉 BOM 并统一换行。 */
export function decodeText(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** 把纯文本切成段落块（导出以便单测）。 */
export function splitPlainText(text: string): RawBlock[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const blocks: RawBlock[] = [];
  for (const chunk of normalized.split(/\n{2,}/)) {
    const trimmed = normalizeBlockText(chunk);
    if (!trimmed) continue;
    if (trimmed.length > MATERIAL_LIMITS.chunkMaxChars && trimmed.includes('\n')) {
      for (const line of trimmed.split('\n')) {
        const lineText = line.trim();
        if (lineText) blocks.push({ text: lineText, kind: 'PARAGRAPH' });
      }
      continue;
    }
    blocks.push({ text: trimmed, kind: 'PARAGRAPH' });
  }
  return blocks;
}

export const txtParser: MaterialParser = {
  format: 'TXT',
  parserVersion: 'txt-1',
  parse(input: MaterialParserInput): ParseResult {
    const text = decodeText(input.bytes);
    const assembled = assembleParagraphs(splitPlainText(text));
    return {
      format: 'TXT',
      title: null,
      paragraphs: assembled.paragraphs,
      text: assembled.text,
      pageCount: null,
      charCount: assembled.charCount,
      wordCount: assembled.wordCount,
      paragraphCount: assembled.paragraphs.length,
      status: 'OK',
      warnings: [],
      droppedElements: {},
      noTextLayerPages: [],
    };
  },
};
