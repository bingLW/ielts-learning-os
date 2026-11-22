/**
 * 段落装配器与展示层工具单测。
 *
 * `assembleParagraphs` 是**全文绝对偏移的唯一来源**，所以这里的断言最严格：
 * 段落区间必须两两不交叠、`charEnd - charStart === text.length`、相邻段落
 * 恰好隔一个 `\n\n`。分块阶段的「不交叠 + 并集覆盖」建立在这个前提上。
 */

import { describe, expect, it } from 'vitest';
import { MATERIAL_LIMITS } from '@/lib/constants';
import { countWords, fileNameToTitle, sanitizeDisplayFileName } from '../displayName';
import { createLocalId } from '../id';
import { PARAGRAPH_SEPARATOR, assembleParagraphs, normalizeBlockText } from '../paragraphs';

describe('normalizeBlockText', () => {
  it('统一换行、去行尾空白、折叠 3+ 空行、去首尾空白', () => {
    expect(normalizeBlockText('a\r\nb')).toBe('a\nb');
    expect(normalizeBlockText('a   \nb')).toBe('a\nb');
    expect(normalizeBlockText('a    b')).toBe('a b');
    expect(normalizeBlockText('a\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeBlockText('   padded   ')).toBe('padded');
  });
});

describe('assembleParagraphs', () => {
  it('段落区间连续、与全文逐字对应，空块被丢弃', () => {
    const document = assembleParagraphs([
      { text: 'A' },
      { text: 'BB' },
      { text: '   ' },
      { text: 'C' },
    ]);

    expect(document.paragraphs).toHaveLength(3);
    expect(document.text).toBe(`A${PARAGRAPH_SEPARATOR}BB${PARAGRAPH_SEPARATOR}C`);
    expect(document.charCount).toBe(document.text.length);

    expect(document.paragraphs[0]).toMatchObject({ charStart: 0, charEnd: 1, paragraphIndex: 1 });
    expect(document.paragraphs[1]).toMatchObject({ charStart: 3, charEnd: 5, paragraphIndex: 2 });
    expect(document.paragraphs[2]).toMatchObject({ charStart: 7, charEnd: 8, paragraphIndex: 3 });

    for (const paragraph of document.paragraphs) {
      expect(document.text.slice(paragraph.charStart, paragraph.charEnd)).toBe(paragraph.text);
      expect(paragraph.charEnd - paragraph.charStart).toBe(paragraph.text.length);
    }
  });

  it('headingLevel 只在 1..6 时生效，且自动推出 HEADING 类型', () => {
    const document = assembleParagraphs([
      { text: 'H', headingLevel: 2 },
      { text: 'P' },
      { text: 'Bad', headingLevel: 9 },
    ]);
    expect(document.paragraphs.map((paragraph) => paragraph.kind)).toEqual([
      'HEADING',
      'PARAGRAPH',
      'PARAGRAPH',
    ]);
    expect(document.paragraphs[2].headingLevel).toBeNull();
  });

  it('显式 kind 优先于 headingLevel 推断（TABLE 不会被改回 HEADING）', () => {
    const document = assembleParagraphs([{ text: 'cell', kind: 'TABLE' }]);
    expect(document.paragraphs[0].kind).toBe('TABLE');
  });

  it('空输入产出空文档', () => {
    const document = assembleParagraphs([]);
    expect(document.paragraphs).toEqual([]);
    expect(document.text).toBe('');
    expect(document.charCount).toBe(0);
    expect(document.wordCount).toBe(0);
  });
});

describe('displayName', () => {
  it('剥路径、去非法字符与控制符', () => {
    expect(sanitizeDisplayFileName('/tmp/../a/b/lesson 1.pdf')).toBe('lesson 1.pdf');
    expect(sanitizeDisplayFileName('a\\b\\c.md')).toBe('c.md');
    expect(sanitizeDisplayFileName('bad:name?.pdf')).toBe('badname.pdf');
    expect(sanitizeDisplayFileName('zero\u200bwidth.txt')).toBe('zerowidth.txt');
  });

  it('空名与超长名都有兜底', () => {
    expect(sanitizeDisplayFileName('   ')).toBe('未命名文件');
    const long = sanitizeDisplayFileName(`${'x'.repeat(300)}.pdf`);
    expect(long).toHaveLength(MATERIAL_LIMITS.maxDisplayFileNameChars);
  });

  it('标题去掉扩展名但保留其它点', () => {
    expect(fileNameToTitle('lesson.1.pdf')).toBe('lesson.1');
    expect(fileNameToTitle('.hidden')).toBe('.hidden');
  });

  it('词数统计同时计 CJK 字与拉丁词', () => {
    expect(countWords('Hello world')).toBe(2);
    expect(countWords('你好世界')).toBe(4);
    expect(countWords('Hello 世界')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});

describe('createLocalId', () => {
  it('带前缀、长度足够、连续两次不重复（磁盘目录名需要提前确定）', () => {
    const first = createLocalId('cm');
    const second = createLocalId('cm');
    expect(first).toMatch(/^cm[0-9a-z]+$/);
    expect(first).not.toBe(second);
    // 目录名安全字符集（storage.ts 的 assertSafeMaterialId 要求 6~64 位）
    expect(first).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
  });
});
