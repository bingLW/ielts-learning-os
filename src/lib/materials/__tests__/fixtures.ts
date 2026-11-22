/**
 * 测试用的 ZIP / DOCX / PDF 构造器（**不提交任何二进制 fixture**）。
 *
 * 理由：仓库里放 `.docx` / `.pdf` 会让 diff 不可读、也无法解释"这个二进制到底是
 * 什么内容"。程序化构造有三个好处：① 每个字节都可解释；② 能精确制造边界样本
 * （压缩炸弹、缺 document.xml、无文本层页）；③ 测试自带"格式规范说明书"作用。
 */

import { deflateRawSync } from 'node:zlib';
import type { MaterialParser, ParseResult } from '../parsers/types';

/**
 * 同步解析器专用调用器：既拿到强类型结果，又顺带断言「该格式的解析器是同步的」
 * （TXT/Markdown/HTML/DOCX 不依赖 pdfjs，必须同步，否则说明实现跑偏了）。
 */
export function parseSync(parser: MaterialParser, bytes: Buffer): ParseResult {
  const output = parser.parse({ bytes });
  if (output instanceof Promise) {
    throw new Error(`${parser.format} 解析器应为同步实现，但返回了 Promise`);
  }
  return output;
}

export interface ZipEntryInput {
  name: string;
  content: string | Buffer;
  /** 0 = stored，8 = deflate（默认）。 */
  method?: 0 | 8;
  /**
   * 伪造中央目录里声明的解压后大小（用于构造 zip bomb 样本）。
   * 只改元数据，不真的写那么多字节。
   */
  declaredUncompressedSize?: number;
}

/** 按 ZIP 规范拼最小可读归档（本地头 + 数据 + 中央目录 + EOCD）。 */
export function buildZip(entries: readonly ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const uncompressedSize = entry.declaredUncompressedSize ?? raw.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, nameBytes, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/**
 * 构造最小 DOCX。
 *
 * @param bodyXml `<w:body>` 内部的内容（段落 / 表格）
 */
export function buildDocx(bodyXml: string): Buffer {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}<w:sectPr/></w:body>
</w:document>`;
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    { name: 'word/document.xml', content: documentXml },
  ]);
}

/** 生成一个 `<w:p>` 段落。 */
export function docxParagraph(text: string, options: { style?: string } = {}): string {
  const style = options.style ? `<w:pPr><w:pStyle w:val="${options.style}"/></w:pPr>` : '';
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** 生成一个 2 列 n 行表格。 */
export function docxTable(rows: readonly (readonly [string, string])[]): string {
  const trs = rows
    .map((cells) => `<w:tr>${cells.map((cell) => `<w:tc>${docxParagraph(cell)}</w:tc>`).join('')}</w:tr>`)
    .join('');
  return `<w:tbl><w:tblPr/>${trs}</w:tbl>`;
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 构造最小合法 PDF（文本型，单页）。
 *
 * 手写 xref 偏移：每个对象的字节位置都算出来，交叉引用表必须逐字节正确，
 * 否则 pdfjs 会拒绝打开（这也正好验证我们的 PDF 解析链路没有作弊）。
 */
export function buildMinimalPdf(text: string, options: { pages?: number } = {}): Buffer {
  const pageCount = Math.max(1, options.pages ?? 1);
  const objects: string[] = [];

  const pageObjectNumbers = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  const fontObjectNumber = 3 + pageCount * 2;

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pageObjectNumbers.map((number) => `${number} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);

  for (let index = 0; index < pageCount; index += 1) {
    const contentObjectNumber = pageObjectNumbers[index] + 1;
    const content = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];
  let cursor = header.length;
  objects.forEach((objectBody, index) => {
    const objectText = `${index + 1} 0 obj\n${objectBody}\nendobj\n`;
    offsets.push(cursor);
    body += objectText;
    cursor += objectText.length;
  });

  const xrefStart = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(`${header}${body}${xref}${trailer}`, 'latin1');
}

function escapePdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
