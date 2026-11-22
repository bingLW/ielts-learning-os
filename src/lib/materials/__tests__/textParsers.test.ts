/**
 * 纯文本 / Markdown 解析器单测（TXT + Markdown）。
 *
 * 每个解析器按验收要求覆盖：正常 1 例 + 边界/拒绝 1 例。
 * 偏移断言一律对照 `assembleParagraphs` 的产物，避免测试自己实现一套算法。
 */

import { describe, expect, it } from 'vitest';
import { MATERIAL_LIMITS } from '@/lib/constants';
import { parseMarkdownBlocks, markdownParser } from '../parsers/markdown';
import { decodeText, splitPlainText, txtParser } from '../parsers/txt';
import { PARAGRAPH_SEPARATOR } from '../paragraphs';
import { parseSync } from './fixtures';

describe('TXT：正常解析', () => {
  it('空行分段，段落偏移与全文一致', () => {
    const result = parseSync(
      txtParser,
      Buffer.from('Hello world.\n\nSecond paragraph here.', 'utf8'),
    );

    expect(result.format).toBe('TXT');
    expect(result.status).toBe('OK');
    expect(result.paragraphCount).toBe(2);
    expect(result.text).toBe(`Hello world.${PARAGRAPH_SEPARATOR}Second paragraph here.`);
    expect(result.paragraphs[0]).toMatchObject({
      paragraphIndex: 1,
      charStart: 0,
      charEnd: 12,
      kind: 'PARAGRAPH',
      headingLevel: null,
      page: null,
    });
    expect(result.paragraphs[1].charStart).toBe(14);
    expect(result.paragraphs[1].charEnd).toBe(result.text.length);
    expect(result.charCount).toBe(result.text.length);
    expect(result.wordCount).toBe(5); // Hello world Second paragraph here
  });

  it('段内单换行保留为软换行（每行一句的字幕式材料）', () => {
    const result = parseSync(txtParser, Buffer.from('line one\nline two', 'utf8'));
    expect(result.paragraphs).toHaveLength(1);
    expect(result.paragraphs[0].text).toBe('line one\nline two');
  });

  it('去掉 BOM 并统一 CRLF', () => {
    expect(decodeText(Buffer.from('\ufeffalpha\r\nbeta', 'utf8'))).toBe('alpha\nbeta');
  });
});

describe('TXT：边界', () => {
  it('空文件解析成 0 段（不抛错，由 parseStage 判空）', () => {
    const result = parseSync(txtParser, Buffer.from('', 'utf8'));
    expect(result.paragraphs).toHaveLength(0);
    expect(result.charCount).toBe(0);
    expect(result.paragraphCount).toBe(0);
  });

  it('只有空白字符也算空文档', () => {
    expect(splitPlainText('\n\n   \n\t\n')).toEqual([]);
  });

  it('超长「每行一句」段落按行再切一层，避免生成巨型段落', () => {
    const line = 'x'.repeat(100);
    const source = Array.from({ length: 30 }, () => line).join('\n');
    expect(source.length).toBeGreaterThan(MATERIAL_LIMITS.chunkMaxChars);

    const blocks = splitPlainText(source);
    expect(blocks).toHaveLength(30);
    expect(blocks.every((block) => block.text.length === 100)).toBe(true);
  });
});

describe('Markdown：正常解析', () => {
  it('标题层级、段落、列表项都能识别，一级标题成为文档标题', () => {
    const result = parseSync(
      markdownParser,
      Buffer.from('# Title\n\nIntro paragraph.\n\n- one\n- two\n\n## Section\n\nBody text.', 'utf8'),
    );

    expect(result.format).toBe('MARKDOWN');
    expect(result.status).toBe('OK');
    expect(result.title).toBe('Title');
    expect(result.paragraphs.map((paragraph) => paragraph.kind)).toEqual([
      'HEADING',
      'PARAGRAPH',
      'LIST',
      'LIST',
      'HEADING',
      'PARAGRAPH',
    ]);
    expect(result.paragraphs[0]).toMatchObject({ text: 'Title', headingLevel: 1 });
    expect(result.paragraphs[4]).toMatchObject({ text: 'Section', headingLevel: 2 });
  });

  it('行内标记被剥离：强调、链接只留文本，图片整体丢弃', () => {
    const { blocks, dropped } = parseMarkdownBlocks(
      '**bold** and _italic_ see [the docs](https://x.com) and ![pie](a.png) now.',
    );
    expect(blocks[0].text).toBe('bold and italic see the docs and now.');
    expect(dropped).toEqual({ image: 1, link: 1 });
  });
});

describe('Markdown：边界与丢弃计数', () => {
  it('front matter / 表格被丢弃并精确计数', () => {
    const source = [
      '---',
      'title: X',
      '---',
      '',
      '# H',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      'See [the docs](https://x.com) and ![img](a.png) now.',
    ].join('\n');

    const result = parseSync(markdownParser, Buffer.from(source, 'utf8'));

    expect(result.droppedElements).toEqual({ frontMatter: 1, table: 2, link: 1, image: 1 });
    expect(result.text).not.toContain('https://x.com');
    expect(result.text).not.toContain('a.png');
    expect(result.text).toContain('See the docs and now.');
  });

  it('空文件 → 0 段', () => {
    const result = parseSync(markdownParser, Buffer.from('', 'utf8'));
    expect(result.paragraphs).toHaveLength(0);
    expect(result.title).toBeNull();
  });

  it('只有 front matter → 0 段且计一次', () => {
    const { blocks, dropped } = parseMarkdownBlocks('---\ntitle: x\n---\n');
    expect(blocks).toEqual([]);
    expect(dropped).toEqual({ frontMatter: 1 });
  });

  it('代码块内容按行保留为独立段落，围栏本身被计数', () => {
    const { blocks, dropped } = parseMarkdownBlocks('```\nfirst line\nsecond line\n```');
    expect(blocks.map((block) => block.text)).toEqual(['first line', 'second line']);
    expect(dropped.codeFence).toBe(2); // 开围栏 + 闭围栏
  });
});
