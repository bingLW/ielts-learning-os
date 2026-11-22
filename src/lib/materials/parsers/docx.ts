/**
 * DOCX 解析器（ADR-02）：ZIP + OOXML，全内存、零依赖。
 *
 * 流程：`readZipIndex`（含体积/压缩比/条目数防护）→ 取 `word/document.xml`
 * → `extractOoxmlBlocks` → `assembleParagraphs`（算绝对偏移）。
 *
 * 错误策略：ZIP 层异常统一转成 `MaterialParseError`，`code` 取
 * `ARCHIVE_LIMIT` / `UNSUPPORTED_FORMAT` / `INVALID_MAGIC` 之一，
 * 上层据此查 `MATERIAL_ERROR_MESSAGES_ZH` 写库（绝不透传原始 message）。
 */

import { assembleParagraphs } from '../paragraphs';
import { extractOoxmlBlocks } from '../ooxmlText';
import { ZipError, readZipEntry, readZipIndex } from '../zip';
import type { MaterialParser, MaterialParserInput, ParseResult } from './types';
import { MaterialParseError } from './types';

const DOCUMENT_ENTRY = 'word/document.xml';

export const docxParser: MaterialParser = {
  format: 'DOCX',
  parserVersion: 'ooxml-1',
  parse(input: MaterialParserInput): ParseResult {
    let documentXml: string;
    try {
      const index = readZipIndex(input.bytes);
      documentXml = readZipEntry(input.bytes, index, DOCUMENT_ENTRY).toString('utf8');
    } catch (error) {
      if (error instanceof ZipError) {
        const code =
          error.code === 'ARCHIVE_LIMIT'
            ? 'ARCHIVE_LIMIT'
            : error.code === 'ENTRY_NOT_FOUND'
              ? 'UNSUPPORTED_FORMAT'
              : 'INVALID_MAGIC';
        throw new MaterialParseError(code, error.message);
      }
      throw new MaterialParseError('INVALID_MAGIC', 'Word 文档解析失败');
    }

    const { blocks, dropped, paragraphCount } = extractOoxmlBlocks(documentXml);
    const assembled = assembleParagraphs(blocks);
    const warnings: string[] = [];
    const droppedTotal = Object.values(dropped).reduce((sum, count) => sum + count, 0);
    if (droppedTotal > 0) {
      warnings.push(
        `已跳过 ${droppedTotal} 个无法解析的元素（图片 ${dropped.droppedImages ?? 0}、` +
          `脚注 ${dropped.droppedFootnotes ?? 0}、批注 ${dropped.droppedComments ?? 0}、` +
          `文本框 ${dropped.droppedTextboxes ?? 0}）`,
      );
    }

    const status: ParseResult['status'] = assembled.paragraphs.length === 0 ? 'PARTIAL' : 'OK';
    if (status === 'PARTIAL') warnings.push('Word 文档里没有可提取的文字（可能全是图片）');

    return {
      format: 'DOCX',
      title: null,
      paragraphs: assembled.paragraphs,
      text: assembled.text,
      pageCount: null,
      charCount: assembled.charCount,
      wordCount: assembled.wordCount,
      paragraphCount,
      status,
      warnings,
      droppedElements: dropped,
      noTextLayerPages: [],
    };
  },
};
