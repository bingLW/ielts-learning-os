/**
 * 分块（ADR-03）单测：架构 §9.1 要求的三条硬性质逐条断言。
 *
 * 1. **绝不切断句子**（缩写 Mr./e.g./U.S. / p.m. 不得被当句界）；
 * 2. **偏移不交叠 + 并集覆盖**（`[charStart,charEnd)` 两两不交、缝隙只有空白）；
 * 3. **确定性**（同输入两次输出逐字节相同）。
 *
 * 段落对象一律由真实的 `assembleParagraphs` 产出 —— 测试绝不自己拼偏移，
 * 否则断言的就是测试自己的算法，而不是产品的算法。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MATERIAL_CHARS_PER_TOKEN, MATERIAL_LIMITS } from '@/lib/constants';
import { chunkParagraphs, computeOverlap, splitSentenceRanges, type ChunkDraft } from '../chunk';
import { assembleParagraphs, PARAGRAPH_SEPARATOR, type RawBlock } from '../paragraphs';

const SENTENCE_END = /[.!?…。！？；;]["'”’)\]}》」』]*$/;

function assemble(blocks: RawBlock[]) {
  return assembleParagraphs(blocks);
}

/**
 * 断言「不交叠 + 并集覆盖 + text 与偏移自洽」。
 *
 * 缝隙允许存在，但必须是纯空白（段落分隔符 `\n\n` 与句间空格都在这里）。
 */
function expectOffsetInvariants(text: string, chunks: readonly ChunkDraft[]): void {
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0].charStart).toBe(0);
  expect(chunks[chunks.length - 1].charEnd).toBe(text.length);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    expect(chunk.seq).toBe(index + 1);
    expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);

    const core = text.slice(chunk.charStart, chunk.charEnd);
    // text = 重叠前缀 + 新增内容，因此 charStart 只标新增内容的起点
    expect(chunk.text.slice(chunk.charStart - chunk.textStart)).toBe(core);
    expect(chunk.text.length).toBe(chunk.charEnd - chunk.textStart);
    expect(chunk.charCount).toBe(chunk.text.length);
    expect(chunk.estTokens).toBe(Math.ceil(chunk.text.length / MATERIAL_CHARS_PER_TOKEN.en));
    expect(chunk.textHash).toBe(createHash('sha256').update(chunk.text, 'utf8').digest('hex'));

    if (index > 0) {
      const previous = chunks[index - 1];
      expect(chunk.charStart).toBeGreaterThanOrEqual(previous.charEnd); // 不交叠
      expect(text.slice(previous.charEnd, chunk.charStart)).toMatch(/^\s*$/); // 缝隙只有空白
    }
  }
}

describe('splitSentenceRanges', () => {
  it('缩写后的句点不算句界（Mr. / e.g. / U.S. / p.m.）', () => {
    const text = 'Mr. Smith flew to the U.S. on Monday. He left at 5 p.m. sharp.';
    const ranges = splitSentenceRanges(text);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      'Mr. Smith flew to the U.S. on Monday.',
      'He left at 5 p.m. sharp.',
    ]);
  });

  it('引号/括号收尾字符归入前一句', () => {
    const text = 'He said "stop." Then (finally) he left.';
    const ranges = splitSentenceRanges(text);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      'He said "stop."',
      'Then (finally) he left.',
    ]);
  });

  it('句点后面紧跟字母时不算句界（版本号、文件名）', () => {
    const text = 'Open file v2.6 now. Then close it.';
    const ranges = splitSentenceRanges(text);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      'Open file v2.6 now.',
      'Then close it.',
    ]);
  });

  it('中文句号与分号都算句界（中文没有空格分隔）', () => {
    const text = '第一句。第二句；第三句！';
    const ranges = splitSentenceRanges(text);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      '第一句。',
      '第二句；',
      '第三句！',
    ]);
  });

  it('无标点时整段算一句', () => {
    const ranges = splitSentenceRanges('no punctuation here at all');
    expect(ranges).toEqual([{ start: 0, end: 26 }]);
  });
});

describe('chunkParagraphs：不截断句子', () => {
  const SOURCE = [
    'Dr. Smith arrived in the U.S. on Monday.',
    'He met Mr. Jones at 5 p.m. sharp.',
    'They discussed the plan, e.g. the budget, and agreed.',
  ].join(' ');

  it('目标字符数很小也只在句界收口，缩写不会被切开', () => {
    const { paragraphs, text } = assemble([{ text: SOURCE, kind: 'PARAGRAPH' }]);
    const result = chunkParagraphs(paragraphs, { targetChars: 20, overlapChars: 0 });

    const cores = result.chunks.map((chunk) => text.slice(chunk.charStart, chunk.charEnd));
    expect(cores).toEqual([
      'Dr. Smith arrived in the U.S. on Monday.',
      'He met Mr. Jones at 5 p.m. sharp.',
      'They discussed the plan, e.g. the budget, and agreed.',
    ]);
    // 任何一块都不得以缩写结尾
    for (const core of cores) {
      expect(core.endsWith('Dr.')).toBe(false);
      expect(core.endsWith('Mr.')).toBe(false);
      expect(core.endsWith('U.S.')).toBe(false);
      expect(core.endsWith('p.m.')).toBe(false);
      expect(core.endsWith('e.g.')).toBe(false);
      expect(core).toMatch(SENTENCE_END);
    }
    // 句子既没被切断，也没被漏掉
    expect(cores.join(' ')).toBe(SOURCE);
  });

  it('多个段落之间也不会出现半句话的块', () => {
    const { paragraphs, text } = assemble([
      { text: 'Reading improves with deliberate practice.', kind: 'PARAGRAPH' },
      { text: 'Vocabulary breadth predicts comprehension strongly.', kind: 'PARAGRAPH' },
      { text: 'Therefore read widely and review frequently.', kind: 'PARAGRAPH' },
    ]);
    const result = chunkParagraphs(paragraphs, { targetChars: 40 });

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.hardSplits).toBe(0);
    for (const chunk of result.chunks) {
      expect(text.slice(chunk.charStart, chunk.charEnd)).toMatch(SENTENCE_END);
    }
  });
});

describe('chunkParagraphs：偏移不交叠且并集覆盖', () => {
  it('多段落、多句子的文档满足三大性质', () => {
    const { paragraphs, text } = assemble([
      { text: 'Listening is the first skill. It needs daily practice.', kind: 'PARAGRAPH' },
      {
        text: 'Reading and listening share the same decoding machinery, which is why '
          + 'transcribing audio by hand transfers to reading speed.',
        kind: 'PARAGRAPH',
      },
      { text: 'Speaking follows. Writing comes last.', kind: 'PARAGRAPH' },
    ]);

    const result = chunkParagraphs(paragraphs, { targetChars: 80, overlapChars: 40 });
    expectOffsetInvariants(text, result.chunks);
    expect(result.truncated).toBe(false);
    expect(result.hardSplits).toBe(0);

    // 并集覆盖：把所有新增区间拼起来（含缝隙）必须还原全文
    let rebuilt = '';
    for (let index = 0; index < result.chunks.length; index += 1) {
      const chunk = result.chunks[index];
      if (index > 0) rebuilt += text.slice(result.chunks[index - 1].charEnd, chunk.charStart);
      rebuilt += text.slice(chunk.charStart, chunk.charEnd);
    }
    expect(rebuilt).toBe(text);
  });

  it('重叠只体现在 text/textStart，绝不污染 charStart/charEnd', () => {
    const { paragraphs, text } = assemble([
      { text: 'Sentence number one is short. Sentence number two is also short. Sentence number three closes it.' },
    ]);
    // targetChars 25 < 单句长度 28：保证「一句一块」，重叠来源可预期
    const result = chunkParagraphs(paragraphs, { targetChars: 25, overlapChars: 220 });

    const second = result.chunks[1];
    expect(second.overlapChars).toBeGreaterThan(0);
    expect(second.textStart).toBe(second.charStart - second.overlapChars);
    // 上一块只有一句，因此重叠串就是它整块正文
    expect(second.text.startsWith(result.chunks[0].text)).toBe(true);
    // 高亮区间仍然指向新增内容
    expect(text.slice(second.charStart, second.charEnd).startsWith('Sentence number two')).toBe(true);
    expectOffsetInvariants(text, result.chunks);
  });

  it('一级/二级标题强制开新块，且块内标题路径正确', () => {
    const { paragraphs, text } = assemble([
      { text: 'Preface sentence one. Preface sentence two.', kind: 'PARAGRAPH' },
      { text: 'Chapter 1', headingLevel: 1, kind: 'HEADING' },
      { text: 'Chapter body one. Chapter body two.', kind: 'PARAGRAPH' },
    ]);
    const result = chunkParagraphs(paragraphs, { targetChars: MATERIAL_LIMITS.chunkTargetChars });

    expect(result.chunks).toHaveLength(2);
    const second = result.chunks[1];
    expect(second.charStart).toBe(paragraphs[1].charStart);
    expect(text.slice(second.charStart, second.charEnd)).toMatch(/^Chapter 1/);
    expect(second.kind).toBe('MIXED'); // 标题 + 正文
    expect(second.headingPath).toBe('Chapter 1');
    expect(second.warnings).toContain('starts_at_heading');
  });
});

describe('chunkParagraphs：确定性', () => {
  it('同输入两次输出逐字节相同', () => {
    const { paragraphs } = assemble([
      { text: 'Alpha sentence. Beta sentence. Gamma sentence.', kind: 'PARAGRAPH' },
      { text: 'Delta sentence. Epsilon sentence.', kind: 'PARAGRAPH' },
    ]);
    const first = chunkParagraphs(paragraphs, { targetChars: 30 });
    const second = chunkParagraphs(paragraphs, { targetChars: 30 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('chunkParagraphs：上限与降级', () => {
  it('超长无空格串走 hard_split 并记 warning', () => {
    const { paragraphs } = assemble([{ text: 'x'.repeat(250), kind: 'PARAGRAPH' }]);
    const result = chunkParagraphs(paragraphs, { targetChars: 100, maxChars: 100, overlapChars: 0 });

    expect(result.hardSplits).toBe(3);
    expect(result.chunks.map((chunk) => chunk.charEnd - chunk.charStart)).toEqual([100, 100, 50]);
    expect(result.chunks.every((chunk) => chunk.warnings.includes('hard_split'))).toBe(true);
    expect(result.warnings.some((warning) => warning.startsWith('hard_split'))).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('超过 maxChunks 时停切并置 truncated（材料应落 partial）', () => {
    const sentences = Array.from({ length: 12 }, (_, index) => `Sentence number ${index + 1} is here.`);
    const { paragraphs } = assemble([{ text: sentences.join(' '), kind: 'PARAGRAPH' }]);
    const result = chunkParagraphs(paragraphs, { targetChars: 20, maxChunks: 3 });

    expect(result.truncated).toBe(true);
    expect(result.chunks).toHaveLength(3);
    expect(result.warnings.some((warning) => warning.startsWith('chunk_limit'))).toBe(true);
    // 截断后仍是完整句子
    for (const chunk of result.chunks) {
      expect(chunk.text.slice(chunk.charStart - chunk.textStart)).toMatch(SENTENCE_END);
    }
  });

  it('maxChars 是硬上限：任何一块（不含重叠）都不得跨越', () => {
    const longSentence = `${'word '.repeat(600)}end.`; // ≈3005 字符
    const { paragraphs } = assemble([
      { text: longSentence, kind: 'PARAGRAPH' },
      { text: 'Short tail sentence.', kind: 'PARAGRAPH' },
    ]);
    const result = chunkParagraphs(paragraphs, {
      targetChars: MATERIAL_LIMITS.chunkTargetChars,
      maxChars: MATERIAL_LIMITS.chunkMaxChars,
    });
    for (const chunk of result.chunks) {
      expect(chunk.charEnd - chunk.charStart).toBeLessThanOrEqual(MATERIAL_LIMITS.chunkMaxChars);
    }
    expect(result.hardSplits).toBeGreaterThan(0); // 长句确实走了硬切兜底
  });

  it('空文档返回空结果并给出 warning', () => {
    const result = chunkParagraphs([]);
    expect(result.chunks).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.hardSplits).toBe(0);
    expect(result.warnings.some((warning) => warning.startsWith('empty_document'))).toBe(true);
  });

  it('段落分隔符之间的空白不会漏进任何 chunk 的正文', () => {
    const { paragraphs, text } = assemble([
      { text: 'First paragraph here.', kind: 'PARAGRAPH' },
      { text: 'Second paragraph here.', kind: 'PARAGRAPH' },
    ]);
    expect(text).toContain(PARAGRAPH_SEPARATOR);
    const result = chunkParagraphs(paragraphs, { targetChars: 10 });
    for (const chunk of result.chunks) {
      expect(chunk.text.startsWith(PARAGRAPH_SEPARATOR)).toBe(false);
      expect(chunk.text.endsWith(PARAGRAPH_SEPARATOR)).toBe(false);
    }
    expectOffsetInvariants(text, result.chunks);
  });
});

describe('computeOverlap', () => {
  it('上一块只有一句时整句作为重叠', () => {
    expect(computeOverlap('Only one sentence.', 220)).toBe('Only one sentence.');
  });

  it('最后一句超预算时退回尾部并对齐空格', () => {
    const previous = 'First. A very long trailing sentence that clearly exceeds the budget.';
    const overlap = computeOverlap(previous, 20);
    expect(overlap.length).toBeLessThanOrEqual(20);
    expect(previous.endsWith(overlap)).toBe(true);
    expect(overlap.startsWith(' ')).toBe(false);
  });

  it('预算为 0 或空文本时不产生重叠', () => {
    expect(computeOverlap('Some text.', 0)).toBe('');
    expect(computeOverlap('', 220)).toBe('');
  });
});
