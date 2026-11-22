/**
 * 生成题自检的单测（T11 §3 验收）。
 *
 * 覆盖两类结论：
 * - **硬失败**（永远不入库）：选项数 3–4、标号重复/为空、选项为空、正确答案不在选项里、
 *   题干/解析/引用为空、引文所属段落不存在、引用无法在段落里逐字找到；
 * - **一致性自检**：只有"引用通过回验 **且** 正确选项文本在引用里逐字出现"才是 `pass`，
 *   其余一律 `unchecked`（**绝不做启发式 fail**）。
 */

import { describe, expect, it } from 'vitest';
import {
  checkExerciseDraft,
  computeExerciseDedupeKey,
  EXERCISE_DEDUPE_KEY_LENGTH,
  hasQuoteFailure,
  type ExerciseCheckFailureCode,
  type ExerciseDraftInput,
} from '../exerciseCheck';

const CHUNK_ID = 'ckchunk0000000000000001';
const CHUNK_TEXT =
  'Reading is a skill that improves with deliberate practice. '
  + 'Vocabulary breadth predicts comprehension more strongly than grammar knowledge.';

/** 一段逐字来自 `CHUNK_TEXT` 的引用（≥8 字符）。 */
const QUOTE = 'Reading is a skill that improves with deliberate practice';

/** 一份结构完全合法的草稿（正确答案文本**不在**引用里）。 */
function baseDraft(overrides: Partial<ExerciseDraftInput> = {}): ExerciseDraftInput {
  return {
    type: 'reading_gist',
    targetSkill: 'READING',
    subskill: 'gist_understanding',
    difficulty: 'B1',
    prompt: '这段文字主要在说什么？',
    options: [
      { key: 'A', text: '阅读能力可以通过刻意练习提高' },
      { key: 'B', text: '词汇量决定一切' },
      { key: 'C', text: '这是一份实验报告' },
    ],
    correctKey: 'A',
    explanation: '首句明确指出 reading improves with deliberate practice，其余选项没有依据。',
    evidenceQuote: QUOTE,
    chunkId: CHUNK_ID,
    chunkText: CHUNK_TEXT,
    ...overrides,
  };
}

/** 断言失败并返回失败码集合（便于逐条检查）。 */
function failureCodes(draft: ExerciseDraftInput): ExerciseCheckFailureCode[] {
  const result = checkExerciseDraft(draft);
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  return result.failures.map((failure) => failure.code);
}

describe('checkExerciseDraft：结构硬失败', () => {
  it('合法题通过，并给出答案负载 / 去重键', () => {
    const result = checkExerciseDraft(baseDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.answer.correctKey).toBe('A');
    expect(result.answer.isSingleAnswer).toBe(true);
    expect(result.answer.options).toHaveLength(3);
    // answerJson 必须可反序列化回同样的结构（落库后作答要靠它判分）
    expect(JSON.parse(result.answerJson)).toEqual({
      options: result.answer.options,
      correctKey: 'A',
      isSingleAnswer: true,
    });
    expect(result.dedupeKey).toMatch(new RegExp(`^[0-9a-f]{${EXERCISE_DEDUPE_KEY_LENGTH}}$`));
  });

  it('选项数必须 3–4（2 个 / 5 个都拒绝）', () => {
    expect(failureCodes(
      baseDraft({
        options: [
          { key: 'A', text: '只有两个' },
          { key: 'B', text: '选项' },
        ],
        correctKey: 'A',
      }),
    )).toContain('OPTION_COUNT');

    expect(failureCodes(
      baseDraft({
        options: [
          { key: 'A', text: 'a' },
          { key: 'B', text: 'b' },
          { key: 'C', text: 'c' },
          { key: 'D', text: 'd' },
          { key: 'E', text: 'e' },
        ],
        correctKey: 'A',
      }),
    )).toContain('OPTION_COUNT');
  });

  it('4 个选项是合法的', () => {
    const result = checkExerciseDraft(
      baseDraft({
        options: [
          { key: 'A', text: '一' },
          { key: 'B', text: '二' },
          { key: 'C', text: '三' },
          { key: 'D', text: '四' },
        ],
        correctKey: 'D',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('标号重复 / 标号为空 / 选项文本为空都拒绝', () => {
    expect(failureCodes(
      baseDraft({
        options: [
          { key: 'A', text: '一' },
          { key: 'A', text: '二' },
          { key: 'C', text: '三' },
        ],
      }),
    )).toContain('OPTION_KEY_DUPLICATE');

    expect(failureCodes(
      baseDraft({
        options: [
          { key: '', text: '无标号' },
          { key: 'B', text: '二' },
          { key: 'C', text: '三' },
        ],
        correctKey: 'B',
      }),
    )).toContain('OPTION_KEY_EMPTY');

    expect(failureCodes(
      baseDraft({
        options: [
          { key: 'A', text: '  ' },
          { key: 'B', text: '二' },
          { key: 'C', text: '三' },
        ],
      }),
    )).toContain('OPTION_TEXT_EMPTY');
  });

  it('正确答案必须存在于选项里（否则永远做不对）', () => {
    expect(failureCodes(baseDraft({ correctKey: 'D' }))).toContain('CORRECT_KEY_MISSING');
    expect(failureCodes(baseDraft({ correctKey: '' }))).toContain('CORRECT_KEY_MISSING');
  });

  it('题干 / 解析 / 引用为空都拒绝', () => {
    expect(failureCodes(baseDraft({ prompt: '   ' }))).toContain('PROMPT_EMPTY');
    expect(failureCodes(baseDraft({ explanation: '' }))).toContain('EXPLANATION_EMPTY');
    expect(failureCodes(baseDraft({ evidenceQuote: '  ' }))).toContain('QUOTE_EMPTY');
  });
});

describe('checkExerciseDraft：原文回验', () => {
  it('引文所属段落不存在 → UNKNOWN_CHUNK（且算依据类失败）', () => {
    const result = checkExerciseDraft(baseDraft({ chunkText: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.failures.map((failure) => failure.code);
    expect(codes).toContain('UNKNOWN_CHUNK');
    expect(hasQuoteFailure(result.failures)).toBe(true);
  });

  it('引文无法在段落里逐字找到 → QUOTE_UNVERIFIABLE', () => {
    const result = checkExerciseDraft(
      baseDraft({ evidenceQuote: 'Reading is a skill that improves with mindful repetition' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.failures.map((failure) => failure.code);
    expect(codes).toContain('QUOTE_UNVERIFIABLE');
    expect(hasQuoteFailure(result.failures)).toBe(true);
  });

  it('引文过短（< 8 字符）→ QUOTE_UNVERIFIABLE，文案说明"太短"', () => {
    const result = checkExerciseDraft(baseDraft({ evidenceQuote: 'Read' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failure = result.failures.find((item) => item.code === 'QUOTE_UNVERIFIABLE');
    expect(failure).toBeDefined();
    expect(failure?.messageZh).toContain('太短');
  });

  it('归一化等价（大小写 / 多余空白）仍算通过', () => {
    const result = checkExerciseDraft(
      baseDraft({ evidenceQuote: '  reading IS a skill   that improves with deliberate practice ' }),
    );
    expect(result.ok).toBe(true);
  });

  it('结构性失败不算依据类失败（Action 层要区分 VALIDATION 与 PRECONDITION）', () => {
    const result = checkExerciseDraft(baseDraft({ correctKey: 'D' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(hasQuoteFailure(result.failures)).toBe(false);
  });
});

describe('checkExerciseDraft：一致性自检（只做"能证明才 pass"）', () => {
  it('正确选项文本在引用里逐字出现 → pass', () => {
    // 选项 A 的文本直接取自引用末尾
    const result = checkExerciseDraft(
      baseDraft({
        options: [
          { key: 'A', text: 'deliberate practice' },
          { key: 'B', text: 'grammar knowledge' },
          { key: 'C', text: 'experiment report' },
        ],
        correctKey: 'A',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consistencyCheck).toBe('pass');
    expect(result.consistencyNote).toContain('逐字出现');
  });

  it('引用通过回验但答案文本不在引用里 → unchecked（不是 fail）', () => {
    const result = checkExerciseDraft(baseDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consistencyCheck).toBe('unchecked');
    expect(result.consistencyNote).toContain('人工判断');
  });

  it('中文选项（答案无法字面匹配英文引用）也不会被判 fail', () => {
    const result = checkExerciseDraft(
      baseDraft({
        options: [
          { key: 'A', text: '刻意练习' },
          { key: 'B', text: '词汇量' },
          { key: 'C', text: '语法' },
        ],
        correctKey: 'A',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 关键：绝不因为"匹配不上"就指控题目有问题
    expect(result.consistencyCheck).toBe('unchecked');
  });
});

describe('dedupeKey：D-10 去重键', () => {
  const answerJson = JSON.stringify({ options: [], correctKey: 'A', isSingleAnswer: true });

  it('同入参稳定，任一字段变化都会换键', () => {
    const base = computeExerciseDedupeKey('reading_gist', '题干', answerJson, CHUNK_ID);
    expect(base).toBe(computeExerciseDedupeKey('reading_gist', '题干', answerJson, CHUNK_ID));
    expect(base).not.toBe(computeExerciseDedupeKey('reading_detail', '题干', answerJson, CHUNK_ID));
    expect(base).not.toBe(computeExerciseDedupeKey('reading_gist', '题干2', answerJson, CHUNK_ID));
    expect(base).not.toBe(computeExerciseDedupeKey('reading_gist', '题干', answerJson, 'ckother'));
    expect(base).not.toBe(
      computeExerciseDedupeKey('reading_gist', '题干', `${answerJson} `, CHUNK_ID),
    );
  });

  it('长度固定 16 位十六进制', () => {
    const key = computeExerciseDedupeKey('vocab_in_context', '题干', answerJson, CHUNK_ID);
    expect(key).toHaveLength(EXERCISE_DEDUPE_KEY_LENGTH);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('两次自检同一草稿得到同一个键（幂等）', () => {
    const first = checkExerciseDraft(baseDraft());
    const second = checkExerciseDraft(baseDraft());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.dedupeKey).toBe(second.dedupeKey);
  });
});
