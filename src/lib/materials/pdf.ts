/**
 * PDF 文本层抽取（ADR-01：`pdfjs-dist` legacy build，**仅服务端**）。
 *
 * 三条安全/稳定性约束，逐条对应 ADR-01 的「关键实现约束」：
 * 1. `isEvalSupported: false` —— 关掉 pdfjs 的字体 `eval` 通道（CVE-2024-4367 双保险）；
 * 2. `disableFontFace / useSystemFonts / useWorkerFetch: false` —— 不碰系统字体与网络；
 * 3. **不设 `GlobalWorkerOptions.workerSrc`** —— Node 下走 fake worker，不需要 worker 文件
 *    （设了反而会在打包环境里找不到 worker 脚本）。
 *
 * 另外：`verbosity: 0` 关掉 pdfjs 的 console 噪声，`stopAtErrors: false` 让单页失败
 * 不中断整篇（失败页会被记为「无可提取文本层」，符合 US-8 的降级预期）。
 */

import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** 与 pdfjs 解耦的最小结构类型：便于单测注入假实现，不必 mock 整个模块。 */
export interface PdfTextItemLike {
  str?: string;
  hasEOL?: boolean;
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>;
  cleanup(): void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

/** 传给 `getDocument()` 的参数对象（**单测会断言这里的每一项**）。 */
export interface PdfDocumentOptions {
  data: Uint8Array;
  isEvalSupported: boolean;
  disableFontFace: boolean;
  useSystemFonts: boolean;
  useWorkerFetch: boolean;
  stopAtErrors: boolean;
  verbosity: number;
}

/** 构造 `getDocument()` 的配置。抽成纯函数，配置回归可以被单测锁死。 */
export function pdfDocumentOptions(bytes: Buffer): PdfDocumentOptions {
  return {
    // 复制一份：pdfjs 会接管并可能置空传入的 ArrayBuffer
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    stopAtErrors: false,
    verbosity: 0,
  };
}

/** pdfjs 模块的最小结构（动态 import 的返回形态）。 */
interface PdfJsModule {
  getDocument(params: PdfDocumentOptions): { promise: Promise<PDFDocumentProxy> };
}

/**
 * 动态加载 pdfjs 并打开文档。
 *
 * 用 `await import()` 而不是顶层 import：保证 pdfjs 只在真正处理 PDF 时才被加载，
 * 也不会进入任何客户端 bundle（`next.config.ts` 已把它列为 `serverExternalPackages`）。
 */
export async function loadPdfDocument(bytes: Buffer): Promise<PdfDocumentLike> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsModule;
  const document = await pdfjs.getDocument(pdfDocumentOptions(bytes)).promise;
  return document as unknown as PdfDocumentLike;
}
