/**
 * Mock provider 的「引用契约」（T12 踩坑记录，转成回归用例）。
 *
 * 背景：mock 的 `source_quote` 取自 `excerpt(baseline, 120)`，而 `excerpt` 会在
 * **第一个句号/问号/感叹号/换行**处截断。于是有两种输入会让整轮分析"一条结果都不入库"：
 *
 * 1. 文本以「标题 + 换行」开头 → 引用只剩标题那几个字；
 * 2. 标题/首行本身短于 `SOURCE_QUOTE_MIN_LENGTH`（8）→ `SourceVerifier` 判 `too_short`。
 *
 * 两种情况的表征完全一样：`ExtractionResult` 一行都没有、材料停在 `review_required`
 * 且 `statusReason` 写着「4 条结果因内容异常被丢弃」。写集成测试时踩过一次，
 * 排查花了很久（断言只报"0 不大于 0"）。
 *
 * 这个文件把这层契约钉住：mock 给出的引用必须**够长**且**能在它声称的块里找到**，
 * 否则以后调整 `excerpt` 或 mock 模板时，所有材料集成测试会一起莫名其妙地变红。
 *
 * 文件名说明：原名 `zz-debug.test.ts` 是临时调试文件的残留名（当时本机沙箱的安全
 * 删除规则拒绝 `unlink`/`mv`，只能先改造成真实用例、不许留空壳）。v2.7 T03 收口时
 * 用 `git mv` 改成现在这个名字 —— 内容一直是真的，只是名字会让人以为可以随手删掉。
 */

import { describe, expect, it } from 'vitest';
import { buildMockPayload } from '@/lib/ai/mock';
import { SOURCE_QUOTE_MIN_LENGTH, verifySourceQuote } from '@/lib/materials/sourceVerify';
import type { AiPromptMeta } from '@/lib/ai/types';

/** 造一个"抽取"用的 meta（只用到 baseline 与 chunks 前缀块）。 */
function metaWith(baseline: string, chunkBlock?: string): AiPromptMeta {
  return {
    skill: 'READING',
    objective: '读懂这段材料',
    targetLevel: 'B1',
    baseline,
    ...(chunkBlock ? { materialChunksBlock: chunkBlock } : {}),
  } as AiPromptMeta;
}

const FIRST_SENTENCE =
  'Reading is a skill that improves with deliberate practice and steady attention.';
const REST = 'It also depends on how much vocabulary you already control.';

describe('mock 抽取：引用必须够长、且落在它声称的块里', () => {
  it('首句够长时，三条结果的引用都能通过回验', () => {
    const payload = buildMockPayload('material_extract', metaWith(`${FIRST_SENTENCE} ${REST}`));
    expect(payload.items.length).toBeGreaterThan(0);
    for (const item of payload.items) {
      expect(item.source_quote.length).toBeGreaterThanOrEqual(SOURCE_QUOTE_MIN_LENGTH);
      expect(verifySourceQuote(item.source_quote, `${FIRST_SENTENCE} ${REST}`).verified).toBe(true);
    }
  });

  it('文本以「标题 + 换行」开头时，引用只剩标题 → 会因太短被丢弃（这是坑本身）', () => {
    const baseline = `短标题\n\n${FIRST_SENTENCE} ${REST}`;
    const payload = buildMockPayload('material_extract', metaWith(baseline));
    const quote = payload.items[0].source_quote;
    // 引用被截在第一个换行处：只剩「短标题」
    expect(quote).toBe('短标题');
    expect(quote.length).toBeLessThan(SOURCE_QUOTE_MIN_LENGTH);
    expect(verifySourceQuote(quote, baseline).verified).toBe(false);
    expect(verifySourceQuote(quote, baseline).reason).toBe('too_short');
  });

  it('引用里的 chunk 序号取自本批前缀块（多块材料不会都挂到第 1 块）', () => {
    const payload = buildMockPayload(
      'material_extract',
      metaWith(`${FIRST_SENTENCE} ${REST}`, '[c7 | p.2 ¶3] 正文……'),
    );
    for (const item of payload.items) {
      expect(item.source_chunk_seq).toBe(7);
    }
  });

  it('前缀块缺失时序号保守回落到 1（摘要阶段没有本块信息）', () => {
    const payload = buildMockPayload('material_extract', metaWith(`${FIRST_SENTENCE} ${REST}`));
    for (const item of payload.items) {
      expect(item.source_chunk_seq).toBe(1);
    }
  });
});
