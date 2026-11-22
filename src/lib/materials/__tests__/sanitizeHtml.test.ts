/**
 * HTML 净化器单测（ADR-02）：验收要求「计数精确」，因此这里既断言产物文本，
 * 也逐键断言 `removedCounts` —— 计数错一位就会被发现。
 */

import { describe, expect, it } from 'vitest';
import { decodeEntities, sanitizeHtml } from '../sanitizeHtml';

describe('sanitizeHtml：危险节点连内容一起删', () => {
  it('script / style / iframe 的正文一律不进语料，并各计一次', () => {
    const html = [
      '<!DOCTYPE html>',
      '<!-- note -->',
      '<?xml version="1.0"?>',
      '<p>Alpha</p>',
      "<script>alert('x')</script>",
      '<style>p{color:red}</style>',
      '<iframe src="https://example.com">fallback text</iframe>',
      '<font color="red">Beta</font>',
      '<marquee>Gamma</marquee>',
    ].join('\n');

    const result = sanitizeHtml(html);

    expect(result.text).toBe('Alpha\n\nBeta\nGamma');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toEqual({ tag: 'p', text: 'Alpha' });
    expect(result.blocks[1]).toEqual({ tag: 'body', text: 'Beta\nGamma' });
    // 逐键精确：多一个键、少一个键、数值差 1 都会失败
    expect(result.removedCounts).toEqual({
      doctype: 1,
      comment: 1,
      processingInstruction: 1,
      script: 1,
      style: 1,
      iframe: 1,
      'tag:font': 1,
      'tag:marquee': 1,
    });
  });

  it('开闭标签只按节点计一次（不因 </font> 重复计数）', () => {
    const result = sanitizeHtml('<p><font>a</font><font>b</font></p>');
    expect(result.removedCounts['tag:font']).toBe(2);
    expect(result.text).toBe('ab');
  });

  it('<head> 整棵子树被丢弃（title / script 不再单独计数）', () => {
    const result = sanitizeHtml(
      '<html><head><title>Doc</title><script>var a = 1;</script></head><body><p>Body</p></body></html>',
    );
    expect(result.text).toBe('Body');
    expect(result.removedCounts.head).toBe(1);
    expect(result.removedCounts.script).toBeUndefined();
    expect(result.removedCounts.title).toBeUndefined();
    // <html>/<body> 不在白名单里：标签丢弃、文本保留、各计一次
    expect(result.removedCounts['tag:html']).toBe(1);
    expect(result.removedCounts['tag:body']).toBe(1);
  });
});

describe('sanitizeHtml：属性与 URL 从根上消失', () => {
  it('<a> 只留文本，href / onclick / javascript: 全部不进产物', () => {
    const result = sanitizeHtml(
      '<p>Go <a href="javascript:steal()" onclick="steal()">here</a> now</p>',
      {},
    );
    expect(result.text).toBe('Go here now');
    expect(result.text).not.toContain('javascript');
    expect(result.text).not.toContain('steal');
    expect(result.text).not.toContain('http');
    // 白名单内联标签静默丢弃，不计入 removedCounts
    expect(result.removedCounts['tag:a']).toBeUndefined();
  });

  it('img / link / meta 等 void 元素不留任何痕迹', () => {
    const result = sanitizeHtml(
      '<p><img src="https://x/y.png" onerror="alert(1)"><link rel="x"><meta charset="utf-8">Text</p>',
    );
    expect(result.text).toBe('Text');
    expect(result.removedCounts.img).toBeUndefined();
    expect(result.removedCounts.link).toBe(1);
    expect(result.removedCounts.meta).toBe(1);
  });
});

describe('sanitizeHtml：实体解码边界', () => {
  it('只认命名实体与数字实体，超范围码点降级为 ?', () => {
    const result = sanitizeHtml('<p>a &amp; b &#8212; c &foo; d&nbsp;e &lt;tag&gt;</p>');
    // &#8212;（em dash）落在白名单外 → '?'；&foo; 不是合法实体 → 原样保留
    expect(result.text).toBe('a & b ? c &foo; d e <tag>');
  });

  it('数字实体按十进制/十六进制解析，控制符降级', () => {
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeEntities('&#0;')).toBe('?');
    expect(decodeEntities('&apos;')).toBe("'");
  });
});

describe('sanitizeHtml：块结构', () => {
  it('<br> 变换行、<hr> 结束当前块', () => {
    const result = sanitizeHtml('<p>First line<br>second line</p><hr><p>After rule</p>');
    expect(result.blocks).toEqual([
      { tag: 'p', text: 'First line\nsecond line' },
      { tag: 'p', text: 'After rule' },
    ]);
    expect(result.removedCounts.hr).toBe(1);
  });

  it('text 恒等于 blocks 以 \\n\\n 连接', () => {
    const result = sanitizeHtml('<div><p>One</p><h2>Two</h2><li>Three</li></div>');
    expect(result.text).toBe(result.blocks.map((block) => block.text).join('\n\n'));
    expect(result.blocks.map((block) => block.tag)).toEqual(['p', 'h2', 'li']);
  });
});

describe('sanitizeHtml：上限与畸形输入', () => {
  it('块数超过 maxBlocks 后停止收集，并精确计一次 blockLimit', () => {
    const result = sanitizeHtml('<p>One</p><p>Two</p><p>Three</p><p>Four</p>', { maxBlocks: 2 });
    expect(result.blocks.map((block) => block.text)).toEqual(['One', 'Two']);
    expect(result.removedCounts.blockLimit).toBe(1);
  });

  it('单块超长时按 maxBlockChars 截断并计数', () => {
    const result = sanitizeHtml(`<p>${'x'.repeat(30)}</p>`, { maxBlockChars: 10 });
    expect(result.blocks[0].text).toHaveLength(10);
    expect(result.removedCounts.blockTruncated).toBe(1);
  });

  it('未闭合的 < 当普通文本处理，不丢内容也不死循环', () => {
    expect(sanitizeHtml('a < b').text).toBe('a < b');
    expect(sanitizeHtml('a <').text).toBe('a <');
  });

  it('未闭合注释吞到末尾，且只计一次', () => {
    const result = sanitizeHtml('<!-- never closed <p>hidden</p>');
    expect(result.blocks).toEqual([]);
    expect(result.removedCounts.comment).toBe(1);
  });

  it('空输入返回空结果', () => {
    expect(sanitizeHtml('')).toEqual({ text: '', blocks: [], removedCounts: {} });
  });
});
