/**
 * Markdown 解析器（ADR-02：零依赖，不做完整 CommonMark）。
 *
 * 保留：`#`–`######` 标题层级（→ `headingLevel`，Reader 目录跳转依赖它）、
 * 段落、列表项、引用块、代码块内的纯文本。
 * 丢弃并计数：表格（`| a | b |` 与分隔行）、图片（`![]()`）、内嵌 HTML 标签、
 * 分隔线、front matter。
 *
 * 明确**不**做的事（产品已接受「部分元素未解析」）：链接不保留 URL（只留文本）、
 * 不做 HTML 语义化、不解析脚注引用、不解析数学公式。
 */

import { assembleParagraphs, normalizeBlockText, type RawBlock } from '../paragraphs';
import { decodeText } from './txt';
import type { MaterialParser, MaterialParserInput, ParseResult } from './types';

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HORIZONTAL_RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const FENCE = /^\s*(```+|~~~+)/;
const BLOCKQUOTE = /^\s{0,3}>\s?/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/;
const IMAGE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
/** 内嵌 HTML 标签：以 `>` 有界，避免灾难回溯。 */
const INLINE_HTML = /<\/?[A-Za-z][^>]{0,2000}>/g;
const EMPHASIS = /(\*\*|__|\*|_|~~|`)/g;

/** 清理行内标记，返回纯文本。 */
function stripInline(line: string, dropped: Record<string, number>): string {
  const bump = (key: string, amount = 1): void => {
    dropped[key] = (dropped[key] ?? 0) + amount;
  };

  let text = line;
  IMAGE.lastIndex = 0;
  text = text.replace(IMAGE, () => {
    bump('image');
    return '';
  });
  LINK.lastIndex = 0;
  text = text.replace(LINK, (_match, label: string) => {
    bump('link');
    return label;
  });
  INLINE_HTML.lastIndex = 0;
  text = text.replace(INLINE_HTML, () => {
    bump('inlineHtml');
    return '';
  });
  return text.replace(EMPHASIS, '');
}

export interface MarkdownParseOutcome {
  blocks: RawBlock[];
  dropped: Record<string, number>;
  title: string | null;
}

/** 逐行解析 Markdown（导出以便单测）。 */
export function parseMarkdownBlocks(raw: string): MarkdownParseOutcome {
  const dropped: Record<string, number> = {};
  const bump = (key: string, amount = 1): void => {
    dropped[key] = (dropped[key] ?? 0) + amount;
  };

  let source = raw.replace(/\r\n?/g, '\n');
  // front matter：文件开头的 --- ... ---
  if (source.startsWith('---')) {
    const end = source.indexOf('\n---', 3);
    if (end > 0) {
      source = source.slice(end + 4);
      bump('frontMatter');
    }
  }

  const blocks: RawBlock[] = [];
  const paragraph: string[] = [];
  let inFence = false;
  let inTable = false;
  let title: string | null = null;

  const flushParagraph = (kind: RawBlock['kind'] = 'PARAGRAPH', headingLevel: number | null = null): void => {
    const text = normalizeBlockText(paragraph.join(' '));
    paragraph.length = 0;
    if (!text) return;
    blocks.push({ text, headingLevel, kind: headingLevel ? 'HEADING' : kind });
  };

  for (const line of source.split('\n')) {
    if (FENCE.test(line)) {
      flushParagraph();
      inFence = !inFence;
      bump('codeFence');
      continue;
    }
    if (inFence) {
      // 代码块内容原样保留为独立段落（语言材料里常见逐行例句）
      const codeText = line.replace(/\s+$/, '');
      if (codeText) blocks.push({ text: codeText, kind: 'PARAGRAPH' });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      inTable = false;
      continue;
    }

    if (TABLE_SEPARATOR.test(line) && inTable) continue;
    if (TABLE_ROW.test(line) || (TABLE_SEPARATOR.test(line) && line.includes('|'))) {
      flushParagraph();
      inTable = true;
      bump('table');
      continue;
    }
    inTable = false;

    if (HORIZONTAL_RULE.test(line)) {
      flushParagraph();
      bump('hr');
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = stripInline(heading[2], dropped).trim();
      if (text) {
        blocks.push({ text, headingLevel: level, kind: 'HEADING' });
        if (!title && level === 1) title = text;
      }
      continue;
    }

    const withoutQuote = line.replace(BLOCKQUOTE, '');
    if (LIST_ITEM.test(withoutQuote)) {
      flushParagraph();
      const itemText = stripInline(withoutQuote.replace(LIST_ITEM, ''), dropped).trim();
      if (itemText) blocks.push({ text: itemText, kind: 'LIST' });
      continue;
    }

    paragraph.push(stripInline(withoutQuote, dropped));
  }
  flushParagraph();

  return { blocks, dropped, title };
}

export const markdownParser: MaterialParser = {
  format: 'MARKDOWN',
  parserVersion: 'markdown-1',
  parse(input: MaterialParserInput): ParseResult {
    const source = decodeText(input.bytes);
    const { blocks, dropped, title } = parseMarkdownBlocks(source);
    const assembled = assembleParagraphs(blocks);
    return {
      format: 'MARKDOWN',
      title,
      paragraphs: assembled.paragraphs,
      text: assembled.text,
      pageCount: null,
      charCount: assembled.charCount,
      wordCount: assembled.wordCount,
      paragraphCount: assembled.paragraphs.length,
      status: 'OK',
      warnings: [],
      droppedElements: dropped,
      noTextLayerPages: [],
    };
  },
};
