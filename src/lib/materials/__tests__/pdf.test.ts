/**
 * PDF 解析单测（ADR-01 / T06）。
 *
 * 分两层：
 * 1. **真实字节**：`fixtures.buildMinimalPdf` 手写 xref 的最小 PDF，交给真实
 *    `pdfjs-dist` legacy build 解析 —— 没有任何 mock，能真正验证 ADR-01 的配置
 *    与「文本层抽取」链路；
 * 2. **注入式假 document**：页数上限、无文本层、资源释放（cleanup/destroy）、
 *    8MB 截断这些控制逻辑，用假实现可以精确断言调用序列，不必造 200 页的 PDF。
 */

import { describe, expect, it } from 'vitest';
import { MATERIAL_LIMITS } from '@/lib/constants';
import { pdfDocumentOptions, type PdfDocumentLike } from '../pdf';
import {
  PDF_MIN_CHARS_PER_PAGE,
  createPdfParser,
  extractPdfPages,
  joinTextItems,
  pdfParser,
} from '../parsers/pdf';
import { MaterialParseError } from '../parsers/types';
import { buildMinimalPdf } from './fixtures';

interface FakePageSpec {
  text?: string;
  fail?: boolean;
  extracted?: string;
}

/** 造一个可观测的假 document：记录 getPage / cleanup / destroy 调用。 */
function fakeDocument(pages: FakePageSpec[]): {
  document: PdfDocumentLike;
  calls: { getPage: number[]; cleanup: number[]; destroy: number };
} {
  const calls = { getPage: [] as number[], cleanup: [] as number[], destroy: 0 };
  const document: PdfDocumentLike = {
    numPages: pages.length,
    async getPage(pageNumber: number) {
      calls.getPage.push(pageNumber);
      const spec = pages[pageNumber - 1] ?? {};
      return {
        async getTextContent() {
          if (spec.fail) throw new Error(`第 ${pageNumber} 页取文本失败`);
          return { items: [{ str: spec.extracted ?? spec.text ?? '' }] };
        },
        cleanup() {
          calls.cleanup.push(pageNumber);
        },
      };
    },
    async destroy() {
      calls.destroy += 1;
    },
  };
  return { document, calls };
}

describe('pdfDocumentOptions：ADR-01 配置逐项锁死', () => {
  it('关掉 eval / 系统字体 / worker 网络，并不设 workerSrc', () => {
    const bytes = Buffer.from('%PDF-1.4 dummy', 'latin1');
    const options = pdfDocumentOptions(bytes);

    expect(options.isEvalSupported).toBe(false); // CVE-2024-4367 双保险
    expect(options.disableFontFace).toBe(true);
    expect(options.useSystemFonts).toBe(false);
    expect(options.useWorkerFetch).toBe(false);
    expect(options.stopAtErrors).toBe(false); // 单页失败不中断整篇
    expect(options.verbosity).toBe(0);
    expect(options.data).toBeInstanceOf(Uint8Array);
    // 传副本：pdfjs 会接管并可能置空传入的 buffer
    expect(Buffer.from(options.data).toString('latin1')).toBe('%PDF-1.4 dummy');
  });
});

describe('PDF：真实字节解析（无 mock）', () => {
  it('手写 PDF 能被 pdfjs 打开并取出准确文本', async () => {
    const bytes = buildMinimalPdf('Hello World From Handwritten PDF');
    const outcome = await extractPdfPages(bytes);

    expect(outcome.pageCount).toBe(1);
    expect(outcome.truncated).toBe(false);
    expect(outcome.noTextLayerPages).toEqual([]);
    expect(outcome.pages).toHaveLength(1);
    expect(outcome.pages[0].text).toBe('Hello World From Handwritten PDF');
  });

  it('多页 PDF 逐页取文本，页码从 1 开始', async () => {
    const bytes = buildMinimalPdf('Page body text', { pages: 3 });
    const outcome = await extractPdfPages(bytes);

    expect(outcome.pageCount).toBe(3);
    expect(outcome.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(outcome.pages.every((page) => page.text === 'Page body text')).toBe(true);
  });

  it('pdfParser 端到端：段落带页码、status=OK', async () => {
    const bytes = buildMinimalPdf('Reading practice improves fluency.', { pages: 2 });
    const result = await pdfParser.parse({ bytes });

    expect(result.format).toBe('PDF');
    expect(result.status).toBe('OK');
    expect(result.pageCount).toBe(2);
    expect(result.paragraphs.map((paragraph) => paragraph.page)).toEqual([1, 2]);
    expect(result.noTextLayerPages).toEqual([]);
    expect(result.text).toContain('Reading practice improves fluency.');
  });
});

describe('PDF：页数上限（一页都不解析）', () => {
  it('201 页直接拒绝，且不调用 getPage、仍然 destroy', async () => {
    const { document, calls } = fakeDocument(
      Array.from({ length: MATERIAL_LIMITS.maxPdfPages + 1 }, () => ({ text: 'x'.repeat(40) })),
    );

    let caught: unknown = null;
    try {
      await extractPdfPages(Buffer.alloc(8), { loadDocument: async () => document });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MaterialParseError);
    expect((caught as MaterialParseError).code).toBe('PDF_TOO_MANY_PAGES');
    expect(calls.getPage).toEqual([]); // 省 CPU：拒绝发生在读页之前
    expect(calls.destroy).toBe(1);
  });
});

describe('PDF：无文本层与资源释放', () => {
  it('短于阈值的页记入 noTextLayerPages（扫描页降级依据）', async () => {
    const { document, calls } = fakeDocument([
      { text: 'a'.repeat(PDF_MIN_CHARS_PER_PAGE + 5) },
      { text: 'abc' },
      { text: '' },
    ]);

    const outcome = await extractPdfPages(Buffer.alloc(8), { loadDocument: async () => document });

    expect(outcome.pageCount).toBe(3);
    expect(outcome.pages.map((page) => page.page)).toEqual([1]);
    expect(outcome.noTextLayerPages).toEqual([2, 3]);
    expect(calls.cleanup).toEqual([1, 2, 3]); // 每页都释放
    expect(calls.destroy).toBe(1);
  });

  it('单页取文本抛错时，该页仍 cleanup、整篇 destroy（不泄漏）', async () => {
    const { document, calls } = fakeDocument([{ text: 'a'.repeat(40) }, { fail: true }]);

    await expect(
      extractPdfPages(Buffer.alloc(8), { loadDocument: async () => document }),
    ).rejects.toThrow('第 2 页取文本失败');

    expect(calls.cleanup).toEqual([1, 2]);
    expect(calls.destroy).toBe(1);
  });

  it('解析器把无文本层映射成 PARTIAL + 可读 warning', async () => {
    const { document } = fakeDocument([{ text: 'abc' }, { text: 'b'.repeat(40) }]);
    const parser = createPdfParser({ loadDocument: async () => document });

    const result = await parser.parse({ bytes: Buffer.alloc(8) });

    expect(result.status).toBe('PARTIAL');
    expect(result.noTextLayerPages).toEqual([1]);
    expect(result.droppedElements.noTextLayerPages).toBe(1);
    expect(result.warnings.some((warning) => warning.includes('没有可提取的文本层'))).toBe(true);
    expect(result.paragraphs.map((paragraph) => paragraph.page)).toEqual([2]);
  });
});

describe('PDF：文本总量上限', () => {
  it('累计超过 8MB 字符后停止解析剩余页并标记 truncated', async () => {
    const big = 'a'.repeat(4_500_000);
    const { document, calls } = fakeDocument([{ text: big }, { text: big }, { text: 'never read' }]);

    const outcome = await extractPdfPages(Buffer.alloc(8), { loadDocument: async () => document });

    expect(outcome.truncated).toBe(true);
    expect(outcome.pages).toHaveLength(2);
    expect(calls.getPage).toEqual([1, 2]); // 第 3 页不再读
  });
});

describe('joinTextItems', () => {
  it('hasEOL 补换行、连续空格折叠、首尾裁掉', () => {
    expect(
      joinTextItems([
        { str: 'Hello' },
        { str: '   world', hasEOL: true },
        { str: 'Second  line' },
      ]),
    ).toBe('Hello world\nSecond line');
  });

  it('空 items 返回空串', () => {
    expect(joinTextItems([])).toBe('');
    expect(joinTextItems([{ str: '' }])).toBe('');
  });
});
