/**
 * PDF 解析器（ADR-01 / T06）。
 *
 * 顺序与防护：
 * 1. 打开文档，**先**读 `numPages`：> 200 直接拒绝（一页都不解析，省 CPU）；
 * 2. 逐页 `getTextContent()` → 拼文本 → **立刻 `page.cleanup()`** 释放页资源；
 * 3. 单页可提取字符少于 `PDF_MIN_CHARS_PER_PAGE` → 记入 `noTextLayerPages`
 *    （扫描件/图片页，US-8 的降级依据），材料整体转 `partial`；
 * 4. 累计字符 > 8MB → 停止解析剩余页，标记 `truncated`（材料 partial）；
 * 5. 全部处理完 `doc.destroy()`（在 `finally` 里，异常路径也不泄漏）。
 *
 * 页码从 1 开始，与 Reader 中「第 N 页」一致。
 */

import { MATERIAL_LIMITS } from '@/lib/constants';
import { assembleParagraphs } from '../paragraphs';
import { checkPdfPages } from '../limits';
import { loadPdfDocument, type PdfDocumentLike } from '../pdf';
import { splitPlainText } from './txt';
import { MaterialParseError, type MaterialParser, type MaterialParserInput, type ParseResult } from './types';

/** 单页可提取字符低于该阈值即视为「无文本层」（只有页码/页眉噪声的扫描页也在此列）。 */
export const PDF_MIN_CHARS_PER_PAGE = 12;

export interface PdfPageText {
  page: number;
  text: string;
}

export interface PdfExtractOutcome {
  pages: PdfPageText[];
  noTextLayerPages: number[];
  pageCount: number;
  /** 是否因超出文本总量上限而提前停止。 */
  truncated: boolean;
}

export interface PdfExtractDeps {
  /** 注入点：默认走 `loadPdfDocument`；单测传假实现即可验证控制逻辑。 */
  loadDocument?: (bytes: Buffer) => Promise<PdfDocumentLike>;
}

/** 把 pdfjs 的 text item 拼成纯文本：`hasEOL` 补换行，连续空格折叠。 */
export function joinTextItems(items: ReadonlyArray<{ str?: string; hasEOL?: boolean }>): string {
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item.str === 'string' && item.str.length > 0) parts.push(item.str);
    if (item.hasEOL) parts.push('\n');
  }
  return parts
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 逐页抽文本（导出以便单测直接验证页数上限、无文本层、资源释放）。
 */
export async function extractPdfPages(
  bytes: Buffer,
  deps: PdfExtractDeps = {},
): Promise<PdfExtractOutcome> {
  const loadDocument = deps.loadDocument ?? loadPdfDocument;
  const doc = await loadDocument(bytes);

  try {
    const pageCheck = checkPdfPages(doc.numPages);
    if (!pageCheck.ok) {
      throw new MaterialParseError(pageCheck.code, pageCheck.message);
    }

    const pages: PdfPageText[] = [];
    const noTextLayerPages: number[] = [];
    let extractedChars = 0;
    let truncated = false;

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      let text = '';
      try {
        const content = await page.getTextContent();
        text = joinTextItems(content.items);
      } finally {
        page.cleanup();
      }

      if (text.length < PDF_MIN_CHARS_PER_PAGE) {
        noTextLayerPages.push(pageNumber);
        continue;
      }

      pages.push({ page: pageNumber, text });
      extractedChars += text.length;
      if (extractedChars > MATERIAL_LIMITS.maxExtractedChars) {
        truncated = true;
        break;
      }
    }

    return { pages, noTextLayerPages, pageCount: doc.numPages, truncated };
  } finally {
    await doc.destroy();
  }
}

export interface PdfParserDeps extends PdfExtractDeps {}

/** 构造 PDF 解析器（默认依赖真实 pdfjs；单测可注入假 document）。 */
export function createPdfParser(deps: PdfExtractDeps = {}): MaterialParser {
  return {
    format: 'PDF',
    parserVersion: 'pdfjs-5',
    async parse(input: MaterialParserInput): Promise<ParseResult> {
      const outcome = await extractPdfPages(input.bytes, deps);

      const blocks = outcome.pages.flatMap((page) =>
        splitPlainText(page.text).map((block) => ({ ...block, page: page.page })),
      );
      const assembled = assembleParagraphs(blocks);

      const warnings: string[] = [];
      if (outcome.noTextLayerPages.length > 0) {
        warnings.push(
          `第 ${outcome.noTextLayerPages.join('、')} 页没有可提取的文本层（可能是扫描页），共 ` +
            `${outcome.noTextLayerPages.length} 页未参与分析`,
        );
      }
      if (outcome.truncated) {
        warnings.push('正文超过 8MB 字符上限，已停止解析剩余页面');
      }
      if (assembled.paragraphs.length === 0) {
        warnings.push('这份 PDF 没有可提取的文字（可能是纯扫描件）');
      }

      const degraded =
        outcome.noTextLayerPages.length > 0 || outcome.truncated || assembled.paragraphs.length === 0;

      return {
        format: 'PDF',
        title: null,
        paragraphs: assembled.paragraphs,
        text: assembled.text,
        pageCount: outcome.pageCount,
        charCount: assembled.charCount,
        wordCount: assembled.wordCount,
        paragraphCount: assembled.paragraphs.length,
        status: degraded ? 'PARTIAL' : 'OK',
        warnings,
        droppedElements:
          outcome.noTextLayerPages.length > 0
            ? { noTextLayerPages: outcome.noTextLayerPages.length }
            : {},
        noTextLayerPages: outcome.noTextLayerPages,
      };
    },
  };
}

/** 默认实例（T07 的 parseStage 用这个）。 */
export const pdfParser: MaterialParser = createPdfParser();
