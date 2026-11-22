/**
 * HTML 解析器单测：净化发生在切段之前（顺序不能反）。
 *
 * 断言重点：`<script>` 里的代码不会变成段落文本、块级标签映射到正确的
 * `headingLevel` / `kind`、导航残留被过滤、无正文时降级为 PARTIAL。
 */

import { describe, expect, it } from 'vitest';
import { htmlParser } from '../parsers/html';
import { PARAGRAPH_SEPARATOR } from '../paragraphs';
import { parseSync } from './fixtures';

const ARTICLE = `<!DOCTYPE html>
<html><head><title>Doc</title><script>var leaked = 1;</script></head>
<body>
<h1>Listening Skills</h1>
<p>Listening is the first skill. It needs daily practice.</p>
<ul><li>Shadowing</li><li>Dictation</li></ul>
<table><tr><td>Band</td><td>Score</td></tr></table>
<nav>Home | About</nav>
</body></html>`;

describe('HTML：正常解析', () => {
  it('标题/段落/列表/表格各自映射到正确的 kind 与 headingLevel', () => {
    const result = parseSync(htmlParser, Buffer.from(ARTICLE, 'utf8'));

    expect(result.format).toBe('HTML');
    expect(result.status).toBe('OK');
    expect(result.paragraphs.map((paragraph) => paragraph.kind)).toEqual([
      'HEADING',
      'PARAGRAPH',
      'LIST',
      'LIST',
      'TABLE',
      'TABLE',
    ]);
    expect(result.paragraphs[0]).toMatchObject({
      text: 'Listening Skills',
      headingLevel: 1,
    });
    expect(result.paragraphs[1].text).toBe(
      'Listening is the first skill. It needs daily practice.',
    );
    expect(result.text).toBe(
      result.paragraphs.map((paragraph) => paragraph.text).join(PARAGRAPH_SEPARATOR),
    );
    expect(result.charCount).toBe(result.text.length);
  });

  it('script 代码与 <head> 内容不进正文；导航残留被过滤', () => {
    const result = parseSync(htmlParser, Buffer.from(ARTICLE, 'utf8'));

    expect(result.text).not.toContain('var leaked');
    expect(result.text).not.toContain('Home | About');
    expect(result.paragraphs.some((paragraph) => paragraph.text.includes('About'))).toBe(false);
    expect(result.droppedElements.head).toBe(1);
    expect(result.droppedElements.script).toBeUndefined(); // 已被 <head> 整棵吞掉
  });
});

describe('HTML：边界与降级', () => {
  it('纯导航页 → 0 段 + PARTIAL + 面向用户的 warning', () => {
    const result = parseSync(htmlParser, Buffer.from('<nav>Home | About</nav><p>Login</p>', 'utf8'));

    expect(result.paragraphs).toHaveLength(0);
    expect(result.status).toBe('PARTIAL');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('没有可提取的正文');
  });

  it('只有脚本的空页面同样降级为 PARTIAL，且不抛错', () => {
    const result = parseSync(
      htmlParser,
      Buffer.from(
        '<html><head><script>alert(1)</script></head><body></body></html>',
        'utf8',
      ),
    );

    expect(result.paragraphs).toHaveLength(0);
    expect(result.status).toBe('PARTIAL');
    expect(result.droppedElements.head).toBe(1);
  });

  it('属性里的 onerror / javascript: 不进入正文（净化先于切段）', () => {
    const result = parseSync(
      htmlParser,
      Buffer.from(
        '<p><img src=x onerror="alert(1)"><a href="javascript:alert(2)">Click</a> safely.</p>',
        'utf8',
      ),
    );

    expect(result.text).toBe('Click safely.');
    expect(result.text).not.toContain('alert');
    expect(result.text).not.toContain('javascript');
  });
});
