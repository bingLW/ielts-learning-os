/**
 * HTML 解析器（ADR-02）：先过 `sanitizeHtml` 白名单，再切段。
 *
 * 顺序不能反：净化必须发生在切段之前，否则 `<script>` 内的 `if (a < b)` 会被
 * 当成文本切进段落。净化器已经把内容丢弃、属性清空，这里只负责：
 * 1. 把块级标签映射成 `headingLevel`（h1–h6）与 `kind`（HEADING / LIST / TABLE / PARAGRAPH）；
 * 2. 丢掉空块与纯导航残留（如只有 "Home | About" 的短行）。
 */

import { assembleParagraphs, type RawBlock } from '../paragraphs';
import { sanitizeHtml, type SanitizedBlock } from '../sanitizeHtml';
import { decodeText } from './txt';
import type { MaterialChunkKind } from '@/lib/constants';
import type { MaterialParser, MaterialParserInput, ParseResult } from './types';

const HEADING_TAGS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const LIST_TAGS = new Set(['li', 'dd', 'dt']);
const TABLE_TAGS = new Set(['tr', 'td', 'th', 'table', 'thead', 'tbody', 'tfoot']);

/** 导航类容器里的短行不构成学习材料（保守过滤：只在块很短且无句读时丢弃）。 */
function looksLikeNavigationChatter(text: string): boolean {
  if (text.length > 60) return false;
  if (/[.!?。！？:；]/.test(text)) return false;
  return /[|»‹]/.test(text) || /^(home|about|contact|login|sign in|menu|search)\b/i.test(text);
}

function toRawBlock(block: SanitizedBlock): RawBlock | null {
  const text = block.text.trim();
  if (!text) return null;

  const headingLevel = HEADING_TAGS[block.tag] ?? null;
  if (headingLevel) return { text, headingLevel, kind: 'HEADING' };
  if (LIST_TAGS.has(block.tag)) return { text, kind: 'LIST' };
  if (TABLE_TAGS.has(block.tag)) return { text, kind: 'TABLE' };
  if (looksLikeNavigationChatter(text)) return null;
  return { text, kind: 'PARAGRAPH' as MaterialChunkKind };
}

export const htmlParser: MaterialParser = {
  format: 'HTML',
  parserVersion: 'html-1',
  parse(input: MaterialParserInput): ParseResult {
    const source = decodeText(input.bytes);
    const sanitized = sanitizeHtml(source);

    const blocks: RawBlock[] = [];
    for (const block of sanitized.blocks) {
      const raw = toRawBlock(block);
      if (raw) blocks.push(raw);
    }
    const assembled = assembleParagraphs(blocks);

    const droppedElements = { ...sanitized.removedCounts };
    const status: ParseResult['status'] = assembled.paragraphs.length === 0 ? 'PARTIAL' : 'OK';
    const warnings = status === 'PARTIAL' ? ['页面没有可提取的正文（可能是纯导航页或需登录）'] : [];

    return {
      format: 'HTML',
      title: null,
      paragraphs: assembled.paragraphs,
      text: assembled.text,
      pageCount: null,
      charCount: assembled.charCount,
      wordCount: assembled.wordCount,
      paragraphCount: assembled.paragraphs.length,
      status,
      warnings,
      droppedElements,
      noTextLayerPages: [],
    };
  },
};
