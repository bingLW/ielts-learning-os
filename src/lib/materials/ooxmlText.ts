/**
 * OOXML（`word/document.xml`）文本提取（ADR-02：零依赖）。
 *
 * 只做「够用且可解释」的解析：
 * - `<w:p>` = 段落；`<w:pStyle w:val="Heading1..6">` 或 `<w:outlineLvl w:val="0..5">` = 标题层级；
 * - `<w:tbl>` → 行（`<w:tr>`）→ 单元格（`<w:tc>`），单元格内多段用空格连接，行内单元格用 ` | ` 连接；
 * - `<w:t>` 取文本，`<w:tab/>` → `\t`，`<w:br/>` / `<w:cr/>` → `\n`；
 * - **丢弃并计数**：`<w:drawing>`（图片/图表）、`<w:txbxContent>`（文本框）、
 *   `<w:footnoteReference>`（脚注引用）、`<w:commentReference>`（批注引用）、
 *   `<w:delText>`（修订中已删除的文本）。
 *
 * 已知限制（文档已接受）：不支持嵌套表格（Word 里嵌套 `<w:tbl>` 极少见），
 * 遇到时内层表格会被外层单元格逻辑一并取出，层级信息丢失但不丢文本。
 */

export type OoxmlBlockKind = 'HEADING' | 'PARAGRAPH' | 'TABLE';

export interface OoxmlBlock {
  text: string;
  headingLevel: number | null;
  kind: OoxmlBlockKind;
}

export interface OoxmlExtractResult {
  blocks: OoxmlBlock[];
  /** 丢弃元素计数（drawing / textbox / footnoteReference …）。 */
  dropped: Record<string, number>;
  /** 原文里的段落元素数量（含空段），用于 `ParsedDocument.paragraphCount`。 */
  paragraphCount: number;
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** XML 实体解码（只认命名实体与数字实体，其余原样保留）。 */
export function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[entity] ?? match;
  });
}

/** `tab` / `br` 在剥离标签时的临时占位符（私有区控制符，正文里不会出现）。 */
const TAB_MARK = '\u0001';
const BREAK_MARK = '\u0002';

/** 取出 XML 片段里夹在 `<w:t>` 之间的 tab/br 标记（保持原顺序）。 */
function pickMarks(xmlFragment: string): string {
  let output = '';
  for (const char of xmlFragment) {
    if (char === TAB_MARK) output += '\t';
    else if (char === BREAK_MARK) output += '\n';
  }
  return output;
}

/** 从一段 XML（段落 / 单元格 / 文本运行容器）里抽纯文本。 */
export function extractRunText(xml: string): string {
  // 制表符与换行：必须在剥离标签之前换成占位符，否则「夹在两个 <w:t> 之间」的
  // tab/br 会在拼接时丢失，把两个单词粘成一个（"Answer" + "B" → "AnswerB"）。
  const withMarks = xml
    .replace(/<w:tab\b[^>]*\/?>/g, TAB_MARK)
    .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, BREAK_MARK);

  // 只取 <w:t> 内容（其余标签全部丢弃，包括域代码 w:instrText）
  const parts: string[] = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let cursor = 0;
  let match = pattern.exec(withMarks);
  while (match !== null) {
    parts.push(pickMarks(withMarks.slice(cursor, match.index)));
    parts.push(decodeXmlEntities(match[1]));
    cursor = match.index + match[0].length;
    match = pattern.exec(withMarks);
  }
  // 只折叠连续空格，保留 \t / \n
  return parts.join('').replace(/ {2,}/g, ' ');
}

/** 定位一个元素并返回内部 XML（不处理同名嵌套，见文件头说明）。 */
function sliceElement(
  xml: string,
  start: number,
  tag: string,
): { inner: string; end: number } {
  const openEnd = xml.indexOf('>', start);
  if (openEnd < 0) return { inner: '', end: xml.length };
  if (xml[openEnd - 1] === '/') return { inner: '', end: openEnd + 1 };
  const close = `</${tag}>`;
  const closeIndex = xml.indexOf(close, openEnd);
  if (closeIndex < 0) return { inner: xml.slice(openEnd + 1), end: xml.length };
  return { inner: xml.slice(openEnd + 1, closeIndex), end: closeIndex + close.length };
}

/** 找到下一个 `<tag>` 或 `<tag ...>` 的位置（避免误匹配 `<tagPr>`）。 */
function findOpenTag(xml: string, tag: string, from: number): number {
  const withAttrs = xml.indexOf(`<${tag} `, from);
  const bare = xml.indexOf(`<${tag}>`, from);
  if (withAttrs < 0) return bare;
  if (bare < 0) return withAttrs;
  return Math.min(withAttrs, bare);
}

/** 段落层级：`Heading1..6` / `heading 1` / `<w:outlineLvl>` / `Title`。 */
export function detectHeadingLevel(paragraphXml: string): number | null {
  const styleMatch = /<w:pStyle[^>]*w:val="([^"]*)"/.exec(paragraphXml);
  if (styleMatch) {
    const value = styleMatch[1].trim();
    const heading = /^heading\s*([1-6])$/i.exec(value);
    if (heading) return Number(heading[1]);
    if (/^title$/i.test(value)) return 1;
  }
  const outline = /<w:outlineLvl[^>]*w:val="([0-8])"/.exec(paragraphXml);
  if (outline) {
    const level = Number(outline[1]) + 1;
    return level <= 6 ? level : null;
  }
  return null;
}

/** 单元格 → 文本（内部多个段落用空格连接）。 */
function extractCellText(cellXml: string): string {
  const paragraphs: string[] = [];
  let cursor = findOpenTag(cellXml, 'w:p', 0);
  while (cursor >= 0) {
    const { inner, end } = sliceElement(cellXml, cursor, 'w:p');
    const text = extractRunText(inner).trim();
    if (text) paragraphs.push(text);
    cursor = findOpenTag(cellXml, 'w:p', end);
  }
  if (paragraphs.length === 0) {
    // 单元格里可能只有一段未被 <w:p> 包裹的 w:t（极小概率），兜底取一次
    return extractRunText(cellXml).trim();
  }
  return paragraphs.join(' ');
}

function extractTableBlock(tableXml: string): string {
  const rows: string[] = [];
  let rowCursor = findOpenTag(tableXml, 'w:tr', 0);
  while (rowCursor >= 0) {
    const { inner: rowXml, end } = sliceElement(tableXml, rowCursor, 'w:tr');
    const cells: string[] = [];
    let cellCursor = findOpenTag(rowXml, 'w:tc', 0);
    while (cellCursor >= 0) {
      const { inner: cellXml, end: cellEnd } = sliceElement(rowXml, cellCursor, 'w:tc');
      const text = extractCellText(cellXml);
      if (text) cells.push(text);
      cellCursor = findOpenTag(rowXml, 'w:tc', cellEnd);
    }
    if (cells.length > 0) rows.push(cells.join(' | '));
    rowCursor = findOpenTag(tableXml, 'w:tr', end);
  }
  return rows.join('\n');
}

/** 需要整段丢弃（连内容）的元素：名字 → 计数键。 */
const DROP_ELEMENTS: Array<{ tag: string; key: string }> = [
  { tag: 'w:drawing', key: 'droppedImages' },
  { tag: 'w:txbxContent', key: 'droppedTextboxes' },
  { tag: 'w:pict', key: 'droppedImages' },
  { tag: 'w:object', key: 'droppedImages' },
];

const DROP_SELF_CLOSING: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /<w:footnoteReference\b[^>]*\/?>/g, key: 'droppedFootnotes' },
  { pattern: /<w:endnoteReference\b[^>]*\/?>/g, key: 'droppedFootnotes' },
  { pattern: /<w:commentReference\b[^>]*\/?>/g, key: 'droppedComments' },
];

/**
 * 把 `word/document.xml` 解析成有序块列表。
 *
 * 扫描策略：同时找最近的 `<w:tbl>` 与 `<w:p>`，谁在前面先处理谁 —— 这样
 * 表格与段落天然保持文档顺序，不需要建 DOM。
 */
export function extractOoxmlBlocks(documentXml: string): OoxmlExtractResult {
  const dropped: Record<string, number> = {};
  const bump = (key: string): void => {
    dropped[key] = (dropped[key] ?? 0) + 1;
  };

  let xml = documentXml;

  // 1) 先计数再删除「连内容一起丢」的元素（图片/文本框等），避免其内部文字混入语料
  for (const { tag, key } of DROP_ELEMENTS) {
    const openPattern = new RegExp(`<${tag}\\b[^>]*?(/?)>`, 'g');
    let match = openPattern.exec(xml);
    while (match !== null) {
      bump(key);
      if (match[1] === '/') {
        xml = xml.slice(0, match.index) + xml.slice(match.index + match[0].length);
      } else {
        const closeIndex = xml.indexOf(`</${tag}>`, match.index);
        const endIndex = closeIndex < 0 ? xml.length : closeIndex + `</${tag}>`.length;
        xml = xml.slice(0, match.index) + xml.slice(endIndex);
      }
      openPattern.lastIndex = match.index;
      match = openPattern.exec(xml);
    }
  }
  for (const { pattern, key } of DROP_SELF_CLOSING) {
    xml = xml.replace(pattern, () => {
      bump(key);
      return '';
    });
  }

  // 2) 按文档顺序扫段落 / 表格
  const blocks: OoxmlBlock[] = [];
  let paragraphCount = 0;
  let cursor = 0;
  while (cursor < xml.length) {
    const nextTable = findOpenTag(xml, 'w:tbl', cursor);
    const nextParagraph = findOpenTag(xml, 'w:p', cursor);

    if (nextTable < 0 && nextParagraph < 0) break;

    if (nextTable >= 0 && (nextParagraph < 0 || nextTable < nextParagraph)) {
      const { inner, end } = sliceElement(xml, nextTable, 'w:tbl');
      const text = extractTableBlock(inner).trim();
      if (text) blocks.push({ text, headingLevel: null, kind: 'TABLE' });
      cursor = end;
      continue;
    }

    const { inner, end } = sliceElement(xml, nextParagraph, 'w:p');
    paragraphCount += 1;
    const rawText = extractRunText(inner).trim();
    if (rawText) {
      const headingLevel = detectHeadingLevel(inner);
      blocks.push({
        text: rawText,
        headingLevel,
        kind: headingLevel ? 'HEADING' : 'PARAGRAPH',
      });
    }
    cursor = end;
  }

  return { blocks, dropped, paragraphCount };
}
