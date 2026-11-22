/**
 * 解析器统一契约（T04–T06 共用）。
 *
 * 关键不变量：`charStart` / `charEnd` 是**相对全文的绝对偏移**，
 * 且由 `assembleParagraphs` 统一计算，任何解析器都不得自己拼偏移
 * —— 否则分块阶段的「并集覆盖 + 不交叠」断言必然失效。
 */

import type { MaterialChunkKind, MaterialFormat } from '@/lib/constants';

/** 一个已规范化的段落（解析器产出的最小单位）。 */
export interface ParsedParagraph {
  text: string;
  /** 1 起；非分页格式为 null。 */
  page: number | null;
  /** 文档级段落序号，1 起单调递增。 */
  paragraphIndex: number;
  /** 相对全文的绝对起始偏移（含）。 */
  charStart: number;
  /** 相对全文的绝对结束偏移（不含）。 */
  charEnd: number;
  /** 1–6：标题层级；普通段落为 null。 */
  headingLevel: number | null;
  kind: MaterialChunkKind;
}

/** 解析结果。 */
export interface ParseResult {
  format: MaterialFormat;
  /** 从文档内部识别到的标题（可选；文件名标题由导入层决定）。 */
  title: string | null;
  paragraphs: ParsedParagraph[];
  /** 全文 = 各段落以 `\n\n` 连接；`charStart/charEnd` 相对它计算。 */
  text: string;
  pageCount: number | null;
  charCount: number;
  wordCount: number;
  /** 解析器看到的段落元素总数（含空段），落 `ParsedDocument.paragraphCount`。 */
  paragraphCount: number;
  /** OK | PARTIAL（有页/段缺失但仍可用）。 */
  status: 'OK' | 'PARTIAL';
  /** 面向用户的人话警告（不含路径、不含全文）。 */
  warnings: string[];
  /** 丢弃元素计数：标签名/元素名 → 次数（写入 ParsedDocument.warningsJson）。 */
  droppedElements: Record<string, number>;
  /** 无可提取文本层的页码（PDF；US-8）。 */
  noTextLayerPages: number[];
}

/** 解析器输入。PDF/DOCX 用 `bytes`；TXT/MD/HTML 两者皆可。 */
export interface MaterialParserInput {
  bytes: Buffer;
  fileName?: string;
}

/** 解析器接口：`parse` 可以是同步的（纯文本），也可以是异步的（pdfjs）。 */
export interface MaterialParser {
  readonly format: MaterialFormat;
  /** 解析器实现版本，落库到 `ParsedDocument.parserVersion`，用于溯源与回归。 */
  readonly parserVersion: string;
  parse(input: MaterialParserInput): Promise<ParseResult> | ParseResult;
}

/**
 * 解析失败（携带领域错误码）。
 *
 * 解析器**只**抛这一种错误；上层（parseStage）把它映射成
 * `MATERIAL_ERROR_MESSAGES_ZH[code]` 再写库，绝不透传原始 `Error.message`。
 */
export class MaterialParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MaterialParseError';
    this.code = code;
  }
}

/** 空结果（解析成功但没有任何文字）。 */
export function emptyParseResult(format: MaterialFormat, parserVersion: string): ParseResult {
  return {
    format,
    title: null,
    paragraphs: [],
    text: '',
    pageCount: null,
    charCount: 0,
    wordCount: 0,
    paragraphCount: 0,
    status: 'PARTIAL',
    warnings: [`${parserVersion}：没有提取到可分析的文本`],
    droppedElements: {},
    noTextLayerPages: [],
  };
}
