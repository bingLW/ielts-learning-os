/**
 * HTML 净化器（ADR-02：零依赖、线性扫描、严格白名单）。
 *
 * 设计取舍（与 `cheerio`/`jsdom` 路线的本质区别）：
 * - **不建 DOM 树**：逐字符 → 逐标签线性扫描，遇到 `>` 就停（所有匹配都以 `>` 有界，
 *   不存在正则回溯风险）；体积 0、无 eval、无网络；
 * - **所有属性一律丢弃**：`on*`、`style`、`src`、`href`、`xlink:href`、`data-*` 全部
 *   不进输出，`javascript:`/`data:`/`vbscript:` 从根上消失，不需要额外黑名单；
 * - **`<a>` 只留文本**：链接文本保留、URL 丢弃（产品允许「部分元素未解析」）；
 * - **删除名单内的元素连内容一起删**（`<script>` 的代码绝不进入语料，否则会污染
 *   chunk 文本、让 SourceVerifier 与注入检测凭空多出噪声）。
 *
 * 输出：
 * - `blocks`：块级文本（`tag` 保留，供 HTML 解析器推出 headingLevel）；
 * - `text`：blocks 以 `\n\n` 连接（与 `assembleParagraphs` 的口径一致）；
 * - `removedCounts`：被删除元素计数（标签名 → 次数），写进 `ParsedDocument.warningsJson`，
 *   UI 显示「已清除 N 个脚本/样式节点」。
 */

/** 块级边界标签：遇到就 flush 当前块。 */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'aside',
  'nav',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
]);

/** 连内容一起删除的元素（白名单外的"危险容器"）。 */
const REMOVE_WITH_CONTENT = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'canvas',
  'video',
  'audio',
  'form',
  'button',
  'select',
  'textarea',
  'title',
  'head',
]);

/** 只删标签本身（void 元素，没有内容）。 */
const REMOVE_VOID = new Set(['input', 'link', 'meta', 'base', 'source', 'track', 'area', 'col']);

/** 真正的 void 元素（输出换行或 flush，不需要闭合）。 */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr', 'embed']);

/** 白名单内联标签：标签本身丢弃、内容保留，且不计入 removedCounts。 */
const ALLOWED_INLINE = new Set([
  'a',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'span',
  'sup',
  'sub',
  'small',
  's',
  'mark',
  'code',
  'abbr',
  'cite',
  'q',
  'time',
  'kbd',
  'samp',
  'var',
  'del',
  'ins',
  'bdi',
  'bdo',
  'ruby',
  'rt',
  'rp',
]);

const ENTITY_PATTERN = /&(#[0-9]+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g;

/** 实体解码：只认 `&amp; &lt; &gt; &quot; &#39; &apos; &nbsp;` 与数字实体。 */
export function decodeEntities(input: string): string {
  return input.replace(ENTITY_PATTERN, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'nbsp':
        return ' ';
      default: {
        const code = entity.startsWith('#x') || entity.startsWith('#X')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (!Number.isFinite(code)) return '?';
        // 只放行可打印 ASCII 与常见拉丁扩展；其余（含 emoji、控制符）一律 '?'
        const printable = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0x24f);
        return printable ? String.fromCodePoint(code) : '?';
      }
    }
  });
}

export interface SanitizedBlock {
  /** 该块最内层块级标签名（`p` / `h2` / `li` / `td` …）。 */
  tag: string;
  text: string;
}

export interface SanitizeResult {
  text: string;
  blocks: SanitizedBlock[];
  removedCounts: Record<string, number>;
}

export interface SanitizeOptions {
  /** 块数硬上限（架构 §6.2：20 000）。 */
  maxBlocks?: number;
  /** 单块字符上限（架构 §6.2：12 000）。 */
  maxBlockChars?: number;
}

const DEFAULT_MAX_BLOCKS = 20_000;
const DEFAULT_MAX_BLOCK_CHARS = 12_000;

/** 块内空白规范化：保留换行（`<br>` 的产物），折叠空格与多余空行。 */
function normalizeBlockWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 线性扫描净化 HTML。
 *
 * @param html 原始 HTML 字符串（调用方已按 UTF-8 解码）
 */
export function sanitizeHtml(html: string, options: SanitizeOptions = {}): SanitizeResult {
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxBlockChars = options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;

  const blocks: SanitizedBlock[] = [];
  const removedCounts: Record<string, number> = {};
  const bump = (key: string, amount = 1): void => {
    removedCounts[key] = (removedCounts[key] ?? 0) + amount;
  };

  let buffer = '';
  let currentTag = 'body';
  let limitHit = false;

  const flush = (): void => {
    const text = normalizeBlockWhitespace(buffer);
    buffer = '';
    if (!text) return;
    if (blocks.length >= maxBlocks) {
      if (!limitHit) {
        bump('blockLimit');
        limitHit = true;
      }
      return;
    }
    if (text.length > maxBlockChars) {
      bump('blockTruncated');
      blocks.push({ tag: currentTag, text: text.slice(0, maxBlockChars) });
      return;
    }
    blocks.push({ tag: currentTag, text });
  };

  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt < 0) {
      buffer += decodeEntities(html.slice(index));
      break;
    }
    if (lt > index) buffer += decodeEntities(html.slice(index, lt));

    // 注释 / 处理指令 / DOCTYPE
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      index = end < 0 ? html.length : end + 3;
      bump('comment');
      continue;
    }
    if (html.startsWith('<?', lt)) {
      const end = html.indexOf('?>', lt + 2);
      index = end < 0 ? html.length : end + 2;
      bump('processingInstruction');
      continue;
    }

    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) {
      // 未闭合的 '<'：当普通文本，绝不无限循环
      buffer += decodeEntities(html.slice(lt));
      break;
    }
    const rawTag = html.slice(lt + 1, gt).trim();
    index = gt + 1;

    if (rawTag.startsWith('!')) {
      bump('doctype');
      continue;
    }

    const closing = rawTag.startsWith('/');
    const selfClosing = rawTag.endsWith('/');
    const nameMatch = /^\/?\s*([A-Za-z][A-Za-z0-9:._-]*)/.exec(rawTag);
    const name = (nameMatch?.[1] ?? '').toLowerCase();
    if (!name) {
      bump('malformedTag');
      continue;
    }

    // 删除名单：连内容一起丢
    if (REMOVE_WITH_CONTENT.has(name)) {
      if (closing) continue;
      const closeTag = `</${name}`;
      const end = html.toLowerCase().indexOf(closeTag, index);
      if (end < 0) {
        index = html.length;
      } else {
        const closeGt = html.indexOf('>', end);
        index = closeGt < 0 ? html.length : closeGt + 1;
      }
      bump(name);
      continue;
    }
    if (REMOVE_VOID.has(name)) {
      if (!closing) bump(name);
      continue;
    }

    if (name === 'br') {
      buffer += '\n';
      continue;
    }
    if (name === 'hr') {
      flush();
      bump('hr');
      continue;
    }
    if (VOID_TAGS.has(name)) continue;

    if (BLOCK_TAGS.has(name)) {
      if (!closing) {
        flush();
        currentTag = name;
      } else {
        flush();
        currentTag = 'body';
      }
      continue;
    }

    // 白名单内联标签（含 <a>）：只丢标签、保留文本，静默不计
    if (ALLOWED_INLINE.has(name)) continue;

    // 白名单外的标签（如 <font>、<marquee>）：标签丢弃、内容保留。
    // 只统计**开标签**：`</font>` 与 `<font>` 是同一个节点，成对计数会让
    // UI 的「已清除 N 个节点」翻倍，验收要求计数精确。
    if (closing) continue;
    bump(`tag:${name}`);
  }
  flush();

  const text = blocks.map((block) => block.text).join('\n\n');
  return { text, blocks, removedCounts };
}
