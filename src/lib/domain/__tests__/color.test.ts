/**
 * PRD §6.1 的 9 组官方案例，逐条断言。
 */

import { describe, expect, it } from 'vitest';
import { judgeEgiuColor } from '../color';

describe('judgeEgiuColor —— PRD §6.1 判定示例', () => {
  const full = (total: number, correct: number) => ({
    total,
    correct,
    explainOK: true,
    sentences: 2,
    coreRuleOK: true,
  });

  it('10/9 + 能说规则 + 造句2 → GREEN', () => {
    const result = judgeEgiuColor(full(10, 9));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.color).toBe('GREEN');
      expect(result.judgment.branch).toBe('FULL');
    }
  });

  it('10/9 但解释不清 → YELLOW', () => {
    const result = judgeEgiuColor({ ...full(10, 9), explainOK: false });
    expect(result.ok && result.judgment.color).toBe('YELLOW');
  });

  it('10/7 → YELLOW（70%–89%）', () => {
    const result = judgeEgiuColor(full(10, 7));
    expect(result.ok && result.judgment.color).toBe('YELLOW');
  });

  it('10/6 且不理解核心规则 → RED（硬否决）', () => {
    const result = judgeEgiuColor({ ...full(10, 6), coreRuleOK: false });
    expect(result.ok && result.judgment.color).toBe('RED');
    if (result.ok) expect(result.judgment.branch).toBe('OVERRIDE');
  });

  it('8/8 但未造句 → YELLOW', () => {
    const result = judgeEgiuColor({ ...full(8, 8), sentences: 0 });
    expect(result.ok && result.judgment.color).toBe('YELLOW');
  });

  it('3/3 + 解释 + 造句 → GREEN（S=1.00）', () => {
    const result = judgeEgiuColor(full(3, 3));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.color).toBe('GREEN');
      expect(result.judgment.branch).toBe('LOW_VOLUME');
      expect(result.judgment.score).toBeCloseTo(1, 5);
    }
  });

  it('3/1 且解释/造句均不达标 → RED（S=0.10）', () => {
    const result = judgeEgiuColor({
      total: 3,
      correct: 1,
      explainOK: false,
      sentences: 0,
      coreRuleOK: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.color).toBe('RED');
      expect(result.judgment.score).toBeCloseTo(0.1, 5);
    }
  });

  it('4/3 + 解释 + 造句1 → YELLOW（S=0.775）', () => {
    const result = judgeEgiuColor({
      total: 4,
      correct: 3,
      explainOK: true,
      sentences: 1,
      coreRuleOK: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.color).toBe('YELLOW');
      expect(result.judgment.score).toBeCloseTo(0.775, 5);
    }
  });

  it('0 题 → PENDING，不判定、不排程', () => {
    const result = judgeEgiuColor({
      total: 0,
      correct: 0,
      explainOK: false,
      sentences: 0,
      coreRuleOK: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.color).toBe('PENDING');
      expect(result.judgment.branch).toBe('ZERO');
    }
  });

  it('correct > total → 返回失败码而不是抛异常', () => {
    const result = judgeEgiuColor(full(3, 5));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CORRECT_GT_TOTAL');
  });

  it('负数输入 → NEGATIVE_INPUT', () => {
    const result = judgeEgiuColor({ ...full(3, 1), sentences: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NEGATIVE_INPUT');
  });
});
