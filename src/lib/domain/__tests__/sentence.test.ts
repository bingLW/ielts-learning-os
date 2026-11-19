/**
 * 被测文件：src/lib/domain/sentence.ts
 * 规则来源：PRD §5.8（句子成分 S/V/O/C/Adverbial 与词性名词/动词/… 是两个独立取值集，
 *           禁止共用字段、禁止互相校验、禁止由成分推导词性）。
 *           SENTENCE_MAX_TOKENS = 60 为防误粘贴上限。
 */

import { describe, expect, it } from 'vitest';
import {
  annotationProgress,
  countComponents,
  countPos,
  createTokens,
  groupByComponent,
  hasCoreComponents,
  rebuildSentence,
  splitSentence,
  summarizeSentenceRows,
  validateTokens,
} from '../sentence';
import { PARTS_OF_SPEECH, SENTENCE_COMPONENTS, SENTENCE_MAX_TOKENS } from '../../constants';
import type { SentenceTokenDto } from '../../types';

function token(over: Partial<SentenceTokenDto> = {}): SentenceTokenDto {
  return { text: 'word', component: null, pos: null, ...over };
}

describe('取值集本身必须不重叠', () => {
  it('成分集合与词性集合没有任何交集', () => {
    const overlap = SENTENCE_COMPONENTS.filter((component) =>
      (PARTS_OF_SPEECH as readonly string[]).includes(component),
    );
    expect(overlap, 'PRD §5.8：两个取值集不得重叠，否则「填错字段」无法被发现').toEqual([]);
  });
});

describe('validateTokens —— 成分与词性互不串用', () => {
  it('把词性值（NOUN）填进成分字段 → INVALID_COMPONENT', () => {
    const result = validateTokens([
      { text: 'boy', component: 'NOUN', pos: null } as unknown as SentenceTokenDto,
    ]);
    expect(result.ok, '成分字段只接受 S/V/O/C/ADVERBIAL，NOUN 必须被拒').toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_COMPONENT');
  });

  it('把成分值（S）填进词性字段 → INVALID_POS', () => {
    const result = validateTokens([
      { text: 'boy', component: null, pos: 'S' } as unknown as SentenceTokenDto,
    ]);
    expect(result.ok, '词性字段只接受名词/动词/…，S 必须被拒').toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_POS');
  });

  it('两个字段都合法且互相独立 → 通过', () => {
    const result = validateTokens([
      token({ text: 'The', component: 'S', pos: 'PRON' }),
      token({ text: 'boy', component: 'S', pos: 'NOUN' }),
      token({ text: 'runs', component: 'V', pos: 'VERB' }),
    ]);
    expect(result.ok, '同一 token 上「主语 + 代词」是合法组合').toBe(true);
  });

  it('只有成分、只有词性、两者都没有 → 都允许（未标注不是错误）', () => {
    expect(validateTokens([token({ component: 'S' })]).ok, '只标成分合法').toBe(true);
    expect(validateTokens([token({ pos: 'NOUN' })]).ok, '只标词性合法').toBe(true);
    expect(validateTokens([token()]).ok, '未标注合法').toBe(true);
  });

  it('空 token 列表 → EMPTY', () => {
    const result = validateTokens([]);
    expect(result.ok, '至少要一个 token').toBe(false);
    if (!result.ok) expect(result.code).toBe('EMPTY');
  });

  it('token 数上限：60 个通过、61 个 TOO_MANY', () => {
    const make = (count: number) =>
      Array.from({ length: count }, (_, index) => token({ text: `w${index}` }));

    expect(SENTENCE_MAX_TOKENS, '上限常量为 60').toBe(60);
    expect(validateTokens(make(60)).ok, '恰好 60 个应通过').toBe(true);

    const tooMany = validateTokens(make(61));
    expect(tooMany.ok, '超过 60 个必须拦截（防整段粘贴）').toBe(false);
    if (!tooMany.ok) expect(tooMany.code).toBe('TOO_MANY');
  });

  it('token 文本为空白 → MISSING_TEXT', () => {
    const result = validateTokens([token({ text: '   ' })]);
    expect(result.ok, '空文本 token 必须被拒').toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_TEXT');
  });

  it('错误码只有一个，不会把成分错误报成词性错误', () => {
    const result = validateTokens([
      token({ text: 'a', component: 'S', pos: 'NOUN' }),
      token({ text: 'b', component: 'ADJ', pos: 'NOUN' } as unknown as SentenceTokenDto),
    ]);
    if (result.ok) throw new Error('ADJ 不是成分取值，应当报错');
    expect(result.code, '成分错误必须是 INVALID_COMPONENT').toBe('INVALID_COMPONENT');
  });
});

describe('统计 —— 成分与词性各自独立计数', () => {
  const tokens: SentenceTokenDto[] = [
    token({ text: 'The', component: 'S', pos: 'PRON' }),
    token({ text: 'boy', component: 'S', pos: 'NOUN' }),
    token({ text: 'runs', component: 'V', pos: 'VERB' }),
    token({ text: 'fast', component: null, pos: null }),
  ];

  it('countComponents 只统计成分，未标注计入 none', () => {
    expect(countComponents(tokens), 'S=2、V=1、none=1').toEqual({
      S: 2,
      V: 1,
      O: 0,
      C: 0,
      ADVERBIAL: 0,
      none: 1,
    });
  });

  it('countPos 只统计词性，未标注计入 none', () => {
    expect(countPos(tokens), 'PRON=1、NOUN=1、VERB=1、none=1').toEqual({
      NOUN: 1,
      VERB: 1,
      ADJ: 0,
      ADV: 0,
      PREP: 0,
      PRON: 1,
      OTHER: 0,
      none: 1,
    });
  });

  it('annotationProgress 两套进度分开统计', () => {
    const progress = annotationProgress([
      token({ component: 'S', pos: null }),
      token({ component: null, pos: 'NOUN' }),
    ]);
    expect(progress.total).toBe(2);
    expect(progress.componentAnnotated, '成分标了 1 个').toBe(1);
    expect(progress.posAnnotated, '词性标了 1 个').toBe(1);
    expect(progress.ratio, 'ratio 只反映成分进度 0.5').toBeCloseTo(0.5, 5);
  });

  it('annotationProgress 空列表不除零', () => {
    expect(annotationProgress([]), '空 token 列表各计数为 0').toEqual({
      total: 0,
      componentAnnotated: 0,
      posAnnotated: 0,
      ratio: 0,
    });
  });

  it('hasCoreComponents 需要同时有 S 与 V', () => {
    expect(hasCoreComponents([token({ component: 'S' }), token({ component: 'V' })])).toBe(true);
    expect(hasCoreComponents([token({ component: 'S' })])).toBe(false);
    expect(hasCoreComponents([token({ component: 'V' })]), '只有谓语不算最小结构').toBe(false);
    expect(hasCoreComponents([token({ pos: 'NOUN' })]), '词性不参与成分判断').toBe(false);
  });
});

describe('切分 / 回填', () => {
  it('splitSentence 压缩空白并去掉首尾空格', () => {
    expect(splitSentence('  I   am\ta   boy. '), '连续空白压成一个分隔').toEqual([
      'I',
      'am',
      'a',
      'boy.',
    ]);
    expect(splitSentence('   '), '纯空白 → 空数组').toEqual([]);
  });

  it('createTokens 生成的成分与词性都是 null', () => {
    const tokens = createTokens('I am a boy.');
    expect(tokens.length).toBe(4);
    expect(
      tokens.every((item) => item.component === null && item.pos === null),
      '未标注必须是 null，不能用空字符串或默认值',
    ).toBe(true);
  });

  it('rebuildSentence 与 splitSentence 互逆', () => {
    expect(rebuildSentence(createTokens('I  am   a boy.'))).toBe('I am a boy.');
  });
});

describe('groupByComponent —— 只按成分合并', () => {
  it('相邻同成分合并为一个语块（不参考词性）', () => {
    const groups = groupByComponent([
      token({ text: 'The', component: 'S', pos: 'PRON' }),
      token({ text: 'young', component: 'S', pos: 'ADJ' }),
      token({ text: 'boy', component: 'S', pos: 'NOUN' }),
      token({ text: 'runs', component: 'V', pos: 'VERB' }),
    ]);
    expect(groups, '词性不同但成分都是 S → 合成一块').toEqual([
      { component: 'S', text: 'The young boy' },
      { component: 'V', text: 'runs' },
    ]);
  });

  it('未标注的相邻 token 也合并成 null 块', () => {
    const groups = groupByComponent([token({ text: 'a' }), token({ text: 'b' })]);
    expect(groups).toEqual([{ component: null, text: 'a b' }]);
  });

  it('成分交替时不合并', () => {
    const groups = groupByComponent([
      token({ text: 'He', component: 'S' }),
      token({ text: 'runs', component: 'V' }),
      token({ text: 'fast', component: 'ADVERBIAL' }),
      token({ text: 'now', component: 'ADVERBIAL' }),
    ]);
    expect(groups.map((group) => group.component)).toEqual(['S', 'V', 'ADVERBIAL']);
  });
});

describe('summarizeSentenceRows —— 列表级统计', () => {
  it('对/错句数与未标注 token 数', () => {
    const summary = summarizeSentenceRows([
      {
        tokens: [token({ component: 'S' }), token({ component: 'V' }), token()],
        isCorrect: true,
      },
      {
        tokens: [token({ component: 'S' }), token()],
        isCorrect: false,
      },
    ]);
    expect(summary.total).toBe(2);
    expect(summary.correct).toBe(1);
    expect(summary.error, 'error = total - correct').toBe(1);
    expect(summary.componentCounts, 'S 合计 2 个').toEqual({
      S: 2,
      V: 1,
      O: 0,
      C: 0,
      ADVERBIAL: 0,
    });
    expect(summary.unannotatedTokens, '两句各 1 个未标注 token').toBe(2);
  });

  it('空列表不除零', () => {
    expect(summarizeSentenceRows([])).toEqual({
      total: 0,
      correct: 0,
      error: 0,
      componentCounts: { S: 0, V: 0, O: 0, C: 0, ADVERBIAL: 0 },
      unannotatedTokens: 0,
    });
  });
});
