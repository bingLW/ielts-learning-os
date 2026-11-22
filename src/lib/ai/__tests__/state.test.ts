import { describe, expect, it } from 'vitest';
import {
  AI_TERMINAL_STATUSES,
  canRequestSupport,
  canScheduleDelayedRetest,
  canStartRetest,
  canTransition,
  hasBaseline,
  hintLeaksAnswer,
  isTerminal,
  nextAllowedHintLevel,
  validateHintRequest,
} from '../state';
import type { HintResult } from '../structured';

describe('AI 会话状态机', () => {
  it('只允许白名单内的状态迁移', () => {
    expect(canTransition('CREATED', 'TASK_PRESENTED')).toBe(true);
    expect(canTransition('TASK_PRESENTED', 'BASELINE_SUBMITTED')).toBe(true);
    expect(canTransition('CREATED', 'FEEDBACK_READY')).toBe(false);
    expect(canTransition('COMPLETED', 'DELAYED_RETEST_SCHEDULED')).toBe(true);
    expect(canTransition('CANCELLED', 'CREATED')).toBe(false);
  });

  it('终态不可再推进', () => {
    for (const status of AI_TERMINAL_STATUSES) expect(isTerminal(status)).toBe(true);
    expect(isTerminal('FEEDBACK_READY')).toBe(false);
  });
});

describe('基线优先守卫', () => {
  it('没有基线时不能请求提示 / 讲解 / 练习', () => {
    expect(hasBaseline({ baselineText: '   ' })).toBe(false);
    expect(
      canRequestSupport({ status: 'FEEDBACK_READY', baselineText: null, directTeaching: false }),
    ).toBe(false);
    expect(
      canRequestSupport({ status: 'HINTING', baselineText: '', directTeaching: false }),
    ).toBe(false);
  });

  it('有基线且处于反馈阶段时允许', () => {
    expect(
      canRequestSupport({
        status: 'FEEDBACK_READY',
        baselineText: 'my baseline',
        directTeaching: false,
      }),
    ).toBe(true);
    expect(
      canRequestSupport({
        status: 'PAUSED',
        baselineText: 'my baseline',
        directTeaching: false,
      }),
    ).toBe(false);
  });
});

describe('提示级别阶梯', () => {
  it('只能逐级 +1，最多 3 级', () => {
    expect(nextAllowedHintLevel(0)).toBe(1);
    expect(nextAllowedHintLevel(1)).toBe(2);
    expect(nextAllowedHintLevel(2)).toBe(3);
    expect(nextAllowedHintLevel(3)).toBe(3);
  });

  it('拒绝跳级和非整数', () => {
    expect(validateHintRequest(0, 2).ok).toBe(false);
    expect(validateHintRequest(0, 1)).toEqual({ ok: true, level: 1 });
    expect(validateHintRequest(3, 3).ok).toBe(true);
    expect(validateHintRequest(3, 4).ok).toBe(false);
    expect(validateHintRequest(0, 0).ok).toBe(false);
  });

  it('业务侧二次防线同样拦截 1–2 级泄露', () => {
    const hint = (level: number, reveals: boolean): HintResult => ({
      hint_level: level,
      hint_text: 'x',
      reveals_answer: reveals,
    });
    expect(hintLeaksAnswer(hint(1, true))).toBe(true);
    expect(hintLeaksAnswer(hint(2, true))).toBe(true);
    expect(hintLeaksAnswer(hint(3, true))).toBe(false);
    expect(hintLeaksAnswer(hint(1, false))).toBe(false);
  });
});

describe('复测时机', () => {
  it('只能在反馈、讲解或练习之后发起即时复测', () => {
    expect(canStartRetest('FEEDBACK_READY')).toBe(true);
    expect(canStartRetest('TEACHING')).toBe(true);
    expect(canStartRetest('PRACTICE')).toBe(true);
    expect(canStartRetest('TASK_PRESENTED')).toBe(false);
    expect(canStartRetest('COMPLETED')).toBe(false);
  });

  it('延迟复测只在完成后可排期', () => {
    expect(canScheduleDelayedRetest('COMPLETED')).toBe(true);
    expect(canScheduleDelayedRetest('DELAYED_RETEST_SCHEDULED')).toBe(true);
    expect(canScheduleDelayedRetest('FEEDBACK_READY')).toBe(false);
  });
});