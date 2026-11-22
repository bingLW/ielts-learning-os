import { describe, expect, it } from 'vitest';
import { detectContentKind, sniffFormat, sniffPlainText } from '../magicNumber';
import { buildDocx, buildMinimalPdf, buildZip } from './fixtures';

const EMPTY_TYPES = '<Types/>';

function verdictOf(bytes: Buffer, fileName: string, declaredMime: string | null = null) {
  return sniffFormat({ bytes, declaredMime, fileName });
}

describe('MIME 魔数嗅探', () => {
  it('文本型 PDF 通过（允许前 1024 字节内的前导垃圾）', () => {
    const pdf = buildMinimalPdf('Hello World');
    expect(verdictOf(pdf, 'article.pdf', 'application/pdf')).toEqual({ ok: true, format: 'PDF' });

    const withJunk = Buffer.concat([Buffer.from('JUNK-BYTES\n'), pdf]);
    expect(verdictOf(withJunk, 'article.pdf', null)).toEqual({ ok: true, format: 'PDF' });
  });

  it('.pdf 实为 ZIP 时拒绝（不解析任意 zip）', () => {
    const zip = buildZip([{ name: 'a.txt', content: 'hello' }]);
    const verdict = verdictOf(zip, 'fake.pdf', 'application/pdf');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('MAGIC_MISMATCH');
      expect(verdict.message).toContain('压缩包');
    }
  });

  it('.docx 必须是含 [Content_Types].xml + word/document.xml 的 OOXML', () => {
    const realDocx = buildDocx('<w:p><w:r><w:t>hello</w:t></w:r></w:p>');
    expect(verdictOf(realDocx, 'unit.docx', null)).toEqual({ ok: true, format: 'DOCX' });

    const arbitraryZip = buildZip([{ name: '[Content_Types].xml', content: EMPTY_TYPES }]);
    const verdict = verdictOf(arbitraryZip, 'unit.docx', null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('MAGIC_MISMATCH');
  });

  it('.docx 实为 PDF 时拒绝', () => {
    const pdf = buildMinimalPdf('Hello');
    const verdict = verdictOf(pdf, 'fake.docx', null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('MAGIC_MISMATCH');
  });

  it('HTML 三种变体（BOM / 大小写 / 前导空白）都能识别', () => {
    expect(verdictOf(Buffer.from('<!DOCTYPE html><html><body>hi</body></html>'), 'a.html', 'text/html')).toEqual({
      ok: true,
      format: 'HTML',
    });
    expect(verdictOf(Buffer.from('\uFEFF\n  <HTML><body>hi</body></HTML>'), 'a.htm', null)).toEqual({
      ok: true,
      format: 'HTML',
    });
    expect(verdictOf(Buffer.from('\n\n<body>hi</body>'), 'a.html', null)).toEqual({ ok: true, format: 'HTML' });
  });

  it('Markdown 用扩展名区分（内容判据与 TXT 相同）', () => {
    const bytes = Buffer.from('# Title\n\nBody text.');
    expect(verdictOf(bytes, 'note.md', null)).toEqual({ ok: true, format: 'MARKDOWN' });
    expect(verdictOf(bytes, 'note.txt', 'text/plain')).toEqual({ ok: true, format: 'TXT' });
  });

  it('控制字符占比 ≥1% 的「txt」被拒绝', () => {
    const dirty = Buffer.concat([Buffer.from('abc'), Buffer.alloc(10, 0x01)]);
    expect(sniffPlainText(dirty).ok).toBe(false);
    const verdict = verdictOf(dirty, 'a.txt', 'text/plain');
    expect(verdict.ok).toBe(false);
  });

  it('含 NUL 的文本被拒绝', () => {
    const bytes = Buffer.from([0x68, 0x69, 0x00, 0x21]);
    expect(sniffPlainText(bytes).ok).toBe(false);
  });

  it('声明 MIME 与内容不符时拒绝', () => {
    const pdf = buildMinimalPdf('Hello');
    const verdict = verdictOf(pdf, 'article.pdf', 'image/png');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('MAGIC_MISMATCH');
  });

  it('空文件与不支持的扩展名各有专门错误码', () => {
    expect(verdictOf(Buffer.alloc(0), 'a.txt')).toMatchObject({ ok: false, code: 'EMPTY_FILE' });
    expect(verdictOf(Buffer.from('hello'), 'a.epub')).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
    });
    expect(verdictOf(Buffer.from('hello'), 'noext')).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  it('音频字节被识别为 AUDIO（P1 暂不支持，但嗅探必须准确）', () => {
    const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 0)]);
    expect(detectContentKind(id3)).toBe('AUDIO');
    const verdict = verdictOf(id3, 'audio.txt', 'text/plain');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain('音频');
  });

  it('WAV / RIFF 与 ISO BMFF 的判别', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4, 0),
      Buffer.from('WAVE'),
      Buffer.alloc(8, 0),
    ]);
    expect(detectContentKind(wav)).toBe('AUDIO');

    const mp4 = Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftypisom'), Buffer.alloc(8, 0)]);
    expect(detectContentKind(mp4)).toBe('VIDEO');

    const m4a = Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftypM4A '), Buffer.alloc(8, 0)]);
    expect(detectContentKind(m4a)).toBe('AUDIO');
  });
});
