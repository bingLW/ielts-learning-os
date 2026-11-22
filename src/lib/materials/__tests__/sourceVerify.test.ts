/**
 * 引用回验单元测试（ADR-04 L4 / AC-03）。
 *
 * 这里固定的是"什么叫真的引用了原文"：排版噪声（空白/大小写/零宽/全角）算通过，
 * 改词、概括、翻译、编造一律不通过 —— 后者正是模型最容易犯的错。
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeForVerify,
  SOURCE_QUOTE_MIN_LENGTH,
  verifyQuoteBatch,
  verifySourceQuote,
} from '@/lib/materials/sourceVerify';

const CHUNK =
  'Reading is a skill that improves with deliberate practice. '
  + 'It also depends on how much vocabulary you already control.';

describe('normalizeForVerify', () => {
  it('折叠空白、小写、去零宽、NFKC 归一', () => {
    expect(normalizeForVerify('  Reading   IS\ta skill  ')).toBe('reading is a skill');
    expect(normalizeForVerify('read\u200Bing\uFEFF')).toBe('reading');
    // 全角字母经 NFKC 变成半角
    expect(normalizeForVerify('Ｒｅａｄｉｎｇ')).toBe('reading');
  });
});

describe('verifySourceQuote：应当通过', () => {
  it('逐字命中', () => {
    expect(verifySourceQuote('improves with deliberate practice', CHUNK))
      .toEqual({ verified: true });
  });

  it('空白差异（多空格 / 换行 / 制表符）通过', () => {
    expect(verifySourceQuote('improves   with\n deliberate\tpractice', CHUNK).verified).toBe(true);
  });

  it('大小写差异通过', () => {
    expect(verifySourceQuote('READING IS A SKILL', CHUNK).verified).toBe(true);
  });

  it('零宽字符差异通过', () => {
    expect(verifySourceQuote('reading is a sk\u200Bill', CHUNK).verified).toBe(true);
  });

  it('全角/半角差异通过（NFKC）', () => {
    expect(verifySourceQuote('Ｒｅａｄｉｎｇ ｉｓ ａ ｓｋｉｌｌ', CHUNK).verified).toBe(true);
  });

  it('中文材料按字面命中', () => {
    const chinese = '阅读是一项可以通过刻意练习提高的技能，词汇量决定了理解的上限。';
    expect(verifySourceQuote('阅读是一项可以通过刻意练习提高的技能', chinese).verified).toBe(true);
  });
});

describe('verifySourceQuote：应当失败', () => {
  it('改词即失败（不许概括/改写）', () => {
    expect(verifySourceQuote('improves with careful practice', CHUNK)).toEqual({
      verified: false,
      reason: 'not_found',
    });
  });

  it('换序失败', () => {
    expect(verifySourceQuote('with deliberate practice improves', CHUNK))
      .toEqual({ verified: false, reason: 'not_found' });
  });

  it('翻译失败', () => {
    // 长度足够（14 字）但英文 chunk 里当然找不到中文原文
    expect(verifySourceQuote('阅读是一项通过练习提高的技能', CHUNK))
      .toEqual({ verified: false, reason: 'not_found' });
  });

  it('归一后长度小于 8 失败（too_short）', () => {
    expect(SOURCE_QUOTE_MIN_LENGTH).toBe(8);
    expect(verifySourceQuote('reading', CHUNK)).toEqual({ verified: false, reason: 'too_short' });
    expect(verifySourceQuote('readin', CHUNK)).toEqual({ verified: false, reason: 'too_short' });
  });

  it('空白差异不改变长度判定：折叠后 8 个字符按内容判失败', () => {
    // 'read  ing' 折叠成 'read ing' 正好 8 个字符 → 不因长度被拒，而是内容对不上
    expect(verifySourceQuote('  read  ing  ', CHUNK)).toEqual({
      verified: false,
      reason: 'not_found',
    });
  });

  it('空串与纯空白失败（empty）', () => {
    expect(verifySourceQuote('', CHUNK)).toEqual({ verified: false, reason: 'empty' });
    expect(verifySourceQuote('   \n\t ', CHUNK)).toEqual({ verified: false, reason: 'empty' });
    expect(verifySourceQuote('\u200B\uFEFF', CHUNK)).toEqual({ verified: false, reason: 'empty' });
  });

  it('chunk 正文为空时一律不通过（不抛异常）', () => {
    expect(verifySourceQuote('reading is a skill', '')).toEqual({
      verified: false,
      reason: 'not_found',
    });
  });
});

describe('verifyQuoteBatch：批量丢弃与计数', () => {
  const chunkTextBySeq = new Map<number, string>([
    [1, CHUNK],
    [2, 'Vocabulary breadth predicts comprehension more strongly than grammar knowledge.'],
  ]);

  it('通过的进 passed，未通过的计入 dropped 并带原因', () => {
    const items = [
      { source_chunk_seq: 1, source_quote: 'improves with deliberate practice' },
      { source_chunk_seq: 1, source_quote: 'improves with careful practice' },
      { source_chunk_seq: 2, source_quote: 'Vocabulary breadth predicts comprehension' },
      { source_chunk_seq: 2, source_quote: 'short' },
      { source_chunk_seq: 9, source_quote: 'no such chunk in this material' },
    ];
    const result = verifyQuoteBatch(items, chunkTextBySeq);

    expect(result.passed).toHaveLength(2);
    expect(result.passed.map((item) => item.source_chunk_seq)).toEqual([1, 2]);
    expect(result.dropped).toBe(3);
    expect(result.droppedDetail).toEqual([
      { seq: 1, reason: 'not_found' },
      { seq: 2, reason: 'too_short' },
      // 模型编了个不存在的 chunk 号：同样算引用造假
      { seq: 9, reason: 'not_found' },
    ]);
  });

  it('全部不合格时 passed 为空（调用方据此不写库）', () => {
    const result = verifyQuoteBatch(
      [{ source_chunk_seq: 1, source_quote: 'totally invented sentence' }],
      chunkTextBySeq,
    );
    expect(result.passed).toEqual([]);
    expect(result.dropped).toBe(1);
  });
});
