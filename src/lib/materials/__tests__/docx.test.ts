/**
 * DOCX（OOXML）单测。
 *
 * fixture 全部**程序化构造**（`fixtures.ts` 的 `buildZip` / `buildDocx`），
 * 仓库不提交任何二进制文件；每个字节都能在测试里读出来，边界样本（缺条目、
 * 压缩炸弹、超长解压）也因此可以精确制造。
 */

import { describe, expect, it } from 'vitest';
import { docxParser } from '../parsers/docx';
import { MaterialParseError } from '../parsers/types';
import {
  decodeXmlEntities,
  detectHeadingLevel,
  extractOoxmlBlocks,
  extractRunText,
} from '../ooxmlText';
import { PARAGRAPH_SEPARATOR } from '../paragraphs';
import { ZipError, readZipEntryByName, readZipIndex } from '../zip';
import { buildDocx, buildZip, docxParagraph, docxTable, parseSync } from './fixtures';

/** 断言同步抛出带领域码的解析错误（解析器只允许抛 `MaterialParseError`）。 */
function expectParseError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MaterialParseError);
    expect((error as MaterialParseError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 MaterialParseError(${code})，但解析成功了`);
}

describe('ooxmlText：文本抽取', () => {
  it('tab / br 即使夹在两个 <w:t> 之间也不丢（不粘词）', () => {
    const xml = '<w:r><w:t>Answer</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r>';
    expect(extractRunText(xml)).toBe('Answer\tB\nC');
  });

  it('xml:space="preserve" 的 w:t 也能取到', () => {
    expect(extractRunText('<w:r><w:t xml:space="preserve">two  spaces</w:t></w:r>')).toBe(
      'two spaces',
    );
  });

  it('域代码 w:instrText 不进正文', () => {
    const xml = '<w:r><w:instrText>PAGE</w:instrText><w:t>12</w:t></w:r>';
    expect(extractRunText(xml)).toBe('12');
  });

  it('实体解码：命名实体与数字实体', () => {
    expect(decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
    expect(decodeXmlEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeXmlEntities('&unknown;')).toBe('&unknown;');
  });

  it('标题层级：pStyle / outlineLvl / Title', () => {
    expect(detectHeadingLevel('<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>')).toBe(2);
    expect(detectHeadingLevel('<w:pPr><w:pStyle w:val="heading 3"/></w:pPr>')).toBe(3);
    expect(detectHeadingLevel('<w:pPr><w:pStyle w:val="Title"/></w:pPr>')).toBe(1);
    expect(detectHeadingLevel('<w:pPr><w:outlineLvl w:val="0"/></w:pPr>')).toBe(1);
    expect(detectHeadingLevel('<w:pPr><w:outlineLvl w:val="7"/></w:pPr>')).toBeNull();
    expect(detectHeadingLevel('<w:pPr><w:pStyle w:val="BodyText"/></w:pPr>')).toBeNull();
  });
});

describe('ooxmlText：块顺序与丢弃计数', () => {
  it('段落与表格保持文档顺序（表格不被提前）', () => {
    const xml = `<w:body>${docxParagraph('Before')}${docxTable([
      ['K', 'V'],
    ])}${docxParagraph('After')}</w:body>`;
    const { blocks, paragraphCount } = extractOoxmlBlocks(xml);
    expect(blocks.map((block) => block.kind)).toEqual(['PARAGRAPH', 'TABLE', 'PARAGRAPH']);
    expect(blocks.map((block) => block.text)).toEqual(['Before', 'K | V', 'After']);
    expect(paragraphCount).toBe(2); // 表格内的 <w:p> 不重复计数
  });

  it('drawing 内的文字被丢弃并计数（图片题注不会混进语料）', () => {
    const xml =
      '<w:body>' +
      '<w:p><w:r><w:t>Keep</w:t></w:r></w:p>' +
      '<w:p><w:r><w:drawing><wp:inline><w:t>SHOULD_NOT_APPEAR</w:t></wp:inline></w:drawing></w:r></w:p>' +
      '<w:p><w:r><w:t>Tail</w:t></w:r></w:p>' +
      '</w:body>';
    const result = extractOoxmlBlocks(xml);
    expect(result.dropped.droppedImages).toBe(1);
    expect(result.blocks.map((block) => block.text)).toEqual(['Keep', 'Tail']);
    expect(result.blocks.some((block) => block.text.includes('SHOULD_NOT_APPEAR'))).toBe(false);
  });

  it('脚注 / 批注引用只计不吞正文', () => {
    const xml =
      '<w:p><w:r><w:t>Text</w:t><w:footnoteReference w:id="1"/><w:commentReference w:id="2"/></w:r></w:p>';
    const result = extractOoxmlBlocks(xml);
    expect(result.blocks[0].text).toBe('Text');
    expect(result.dropped.droppedFootnotes).toBe(1);
    expect(result.dropped.droppedComments).toBe(1);
  });
});

describe('docxParser：正常解析', () => {
  it('标题、正文、表格都能解析出正确层级与绝对偏移', () => {
    const bytes = buildDocx(
      docxParagraph('Chapter 1', { style: 'Heading1' })
        + docxParagraph('First sentence. Second sentence.')
        + docxTable([
          ['Word', 'Meaning'],
          ['bank', 'river side'],
        ]),
    );

    const result = parseSync(docxParser, bytes);

    expect(result.format).toBe('DOCX');
    expect(result.status).toBe('OK');
    expect(result.paragraphCount).toBe(2);
    expect(result.paragraphs.map((paragraph) => paragraph.kind)).toEqual([
      'HEADING',
      'PARAGRAPH',
      'TABLE',
    ]);
    expect(result.paragraphs[0]).toMatchObject({ text: 'Chapter 1', headingLevel: 1 });
    expect(result.paragraphs[2].text).toBe('Word | Meaning\nbank | river side');

    // 偏移只由 assembleParagraphs 计算：区间连续、与全文逐字对应
    expect(result.text).toBe(
      result.paragraphs.map((paragraph) => paragraph.text).join(PARAGRAPH_SEPARATOR),
    );
    for (let index = 0; index < result.paragraphs.length; index += 1) {
      const paragraph = result.paragraphs[index];
      expect(result.text.slice(paragraph.charStart, paragraph.charEnd)).toBe(paragraph.text);
      if (index > 0) {
        expect(paragraph.charStart).toBe(
          result.paragraphs[index - 1].charEnd + PARAGRAPH_SEPARATOR.length,
        );
      }
    }
    expect(result.charCount).toBe(result.text.length);
    expect(result.wordCount).toBeGreaterThan(0);
  });

  it('纯图片文档解析出 0 段并落 PARTIAL（不报错）', () => {
    const bytes = buildDocx(
      '<w:p><w:r><w:drawing><wp:inline><w:t>ignored</w:t></wp:inline></w:drawing></w:r></w:p>',
    );
    const result = parseSync(docxParser, bytes);
    expect(result.paragraphs).toHaveLength(0);
    expect(result.status).toBe('PARTIAL');
    expect(result.droppedElements.droppedImages).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('docxParser：拒绝与边界', () => {
  it('缺少 word/document.xml → UNSUPPORTED_FORMAT', () => {
    const bytes = buildZip([{ name: '[Content_Types].xml', content: '<Types/>' }]);
    expectParseError(() => docxParser.parse({ bytes }), 'UNSUPPORTED_FORMAT');
  });

  it('不是 ZIP（伪装成 .docx） → INVALID_MAGIC', () => {
    const bytes = Buffer.from('this is definitely not a zip archive', 'utf8');
    expectParseError(() => docxParser.parse({ bytes }), 'INVALID_MAGIC');
  });

  it('压缩炸弹（压缩比超限） → ARCHIVE_LIMIT', () => {
    const bytes = buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: 'a'.repeat(200_000) },
    ]);
    expectParseError(() => docxParser.parse({ bytes }), 'ARCHIVE_LIMIT');
  });
});

describe('zip：读条目', () => {
  it('stored(0) 与 deflate(8) 两种条目都能读', () => {
    const bytes = buildZip([
      { name: 'stored.txt', content: 'stored body', method: 0 },
      { name: 'deflated.txt', content: 'deflated body', method: 8 },
    ]);
    expect(readZipEntryByName(bytes, 'stored.txt').toString('utf8')).toBe('stored body');
    expect(readZipEntryByName(bytes, 'deflated.txt').toString('utf8')).toBe('deflated body');
  });

  it('真实 docx 归档含 3 个条目，document.xml 可读', () => {
    const bytes = buildDocx(docxParagraph('Hello'));
    const index = readZipIndex(bytes);
    expect(index.entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]);
    expect(readZipEntryByName(bytes, 'word/document.xml').toString('utf8')).toContain('<w:document');
  });

  it('缺条目 → ENTRY_NOT_FOUND（不返回空 buffer）', () => {
    const bytes = buildDocx(docxParagraph('Hello'));
    expect(() => readZipEntryByName(bytes, 'word/missing.xml')).toThrowError(ZipError);
    try {
      readZipEntryByName(bytes, 'word/missing.xml');
    } catch (error) {
      expect((error as ZipError).code).toBe('ENTRY_NOT_FOUND');
    }
  });
});
