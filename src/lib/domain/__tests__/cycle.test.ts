import { describe, expect, it } from 'vitest';
import {
  buildRecoveryAdvice,
  canReviewWeeklyFocus,
  checkCycleCompletion,
  checkPhaseAdvance,
  computeCycleProgress,
  cycleDayNumber,
  cyclePhaseForDay,
  cycleWeekIndex,
  cycleWeekStart,
  isComparableEvidence,
  isDeliveryEvidence,
  nextCyclePhase,
  weeklyFocusFilledSlots,
  weeklyFocusMissingSlots,
} from '../cycle';
import { CYCLE_WEEKS } from '../../constants';

const START = '2026-01-01';

describe('cycleDayNumber / cyclePhaseForDay', () => {
  it('开始日当天算第 1 天', () => {
    expect(cycleDayNumber(START, '2026-01-01')).toBe(1);
    expect(cycleDayNumber(START, '2026-01-14')).toBe(14);
  });

  it('开始日期之前返回非正数，超过 90 天继续计数', () => {
    expect(cycleDayNumber(START, '2025-12-31')).toBe(0);
    expect(cycleDayNumber(START, '2026-04-01')).toBe(91);
  });

  it('阶段边界：14 校准 / 15 积累 / 56 积累 / 57 交付 / 90 交付', () => {
    expect(cyclePhaseForDay(1)).toBe('CALIBRATION');
    expect(cyclePhaseForDay(14)).toBe('CALIBRATION');
    expect(cyclePhaseForDay(15)).toBe('BUILD');
    expect(cyclePhaseForDay(56)).toBe('BUILD');
    expect(cyclePhaseForDay(57)).toBe('DELIVER');
    expect(cyclePhaseForDay(90)).toBe('DELIVER');
    expect(cyclePhaseForDay(0)).toBeNull();
    expect(cyclePhaseForDay(91)).toBeNull();
  });
});

describe('computeCycleProgress', () => {
  it('第 15 天处于积累阶段，剩余 75 天', () => {
    const progress = computeCycleProgress(START, '2026-01-15');
    expect(progress.dayNumber).toBe(15);
    expect(progress.daysLeft).toBe(75);
    expect(progress.percent).toBe(17);
    expect(progress.phase).toBe('BUILD');
    expect(progress.ended).toBe(false);
    expect(progress.notStarted).toBe(false);
  });

  it('开始前进度为 0，无阶段', () => {
    const progress = computeCycleProgress(START, '2025-12-25');
    expect(progress.percent).toBe(0);
    expect(progress.phase).toBeNull();
    expect(progress.notStarted).toBe(true);
    expect(progress.daysLeft).toBe(90);
  });

  it('超过 90 天进度 100，无阶段，剩余 0', () => {
    const progress = computeCycleProgress(START, '2026-04-05');
    expect(progress.percent).toBe(100);
    expect(progress.daysLeft).toBe(0);
    expect(progress.phase).toBeNull();
    expect(progress.ended).toBe(true);
  });

  it('第 90 天仍为交付阶段，进度 100，剩余 0', () => {
    const progress = computeCycleProgress(START, '2026-03-31');
    expect(progress.dayNumber).toBe(90);
    expect(progress.percent).toBe(100);
    expect(progress.daysLeft).toBe(0);
    expect(progress.phase).toBe('DELIVER');
  });
});

describe('cycleWeekIndex / cycleWeekStart', () => {
  it('周期开始前一周内的周一归入第 1 周', () => {
    expect(cycleWeekIndex(START, '2025-12-29')).toBe(1);
    expect(cycleWeekIndex(START, '2026-01-05')).toBe(1);
  });

  it('第 2 周与最后一周边界', () => {
    expect(cycleWeekIndex(START, '2026-01-12')).toBe(2);
    expect(cycleWeekIndex(START, '2026-03-30')).toBe(CYCLE_WEEKS);
    expect(cycleWeekIndex(START, '2026-04-06')).toBeNull();
    expect(cycleWeekIndex(START, '2025-12-22')).toBeNull();
  });

  it('第 n 周起始日 = 开始日 + (n-1)×7', () => {
    expect(cycleWeekStart(START, 1)).toBe('2026-01-01');
    expect(cycleWeekStart(START, 3)).toBe('2026-01-15');
    expect(cycleWeekStart(START, CYCLE_WEEKS)).toBe('2026-03-26');
  });
});

describe('nextCyclePhase', () => {
  it('校准→积累→交付，交付之后无下一阶段', () => {
    expect(nextCyclePhase('CALIBRATION')).toBe('BUILD');
    expect(nextCyclePhase('BUILD')).toBe('DELIVER');
    expect(nextCyclePhase('DELIVER')).toBeNull();
  });
});

describe('checkPhaseAdvance', () => {
  it('校准阶段不足 4 次可比较输出时拒绝', () => {
    const gate = checkPhaseAdvance('CALIBRATION', {
      comparableOutputs: 3,
      deliveryEvidence: 0,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain('4 次可比较输出');
  });

  it('校准阶段满 4 次可放行', () => {
    expect(
      checkPhaseAdvance('CALIBRATION', { comparableOutputs: 4, deliveryEvidence: 0 }).ok,
    ).toBe(true);
  });

  it('积累阶段没有交付证据时拒绝，有 1 条放行', () => {
    const blocked = checkPhaseAdvance('BUILD', { comparableOutputs: 9, deliveryEvidence: 0 });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain('实际应用或迁移验证');
    expect(
      checkPhaseAdvance('BUILD', { comparableOutputs: 9, deliveryEvidence: 1 }).ok,
    ).toBe(true);
  });

  it('交付阶段不能再推进', () => {
    const gate = checkPhaseAdvance('DELIVER', { comparableOutputs: 20, deliveryEvidence: 5 });
    expect(gate.ok).toBe(false);
  });
});

describe('checkCycleCompletion', () => {
  it('第 56 天前不能完成', () => {
    const gate = checkCycleCompletion(56, { comparableOutputs: 10, deliveryEvidence: 2 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain('不能结束周期');
  });

  it('超过积累期但缺少交付证据时拒绝', () => {
    const gate = checkCycleCompletion(57, { comparableOutputs: 10, deliveryEvidence: 0 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain('至少需要 1 条');
  });

  it('过积累期且有交付证据时放行', () => {
    expect(checkCycleCompletion(57, { comparableOutputs: 10, deliveryEvidence: 1 }).ok).toBe(
      true,
    );
  });
});

describe('isComparableEvidence / isDeliveryEvidence', () => {
  it('Quick 或有产出缺失都不算可比较输出', () => {
    expect(isComparableEvidence({ level: 'QUICK', outputText: 'some text' })).toBe(false);
    expect(isComparableEvidence({ level: 'STANDARD', outputText: '   ' })).toBe(false);
    expect(isComparableEvidence({ level: 'STANDARD', outputText: null })).toBe(false);
    expect(isComparableEvidence({ level: 'STANDARD', outputText: 'essay' })).toBe(true);
    expect(isComparableEvidence({ level: 'FULL', outputText: 'essay' })).toBe(true);
  });

  it('实际应用与迁移验证算交付证据，其余不算', () => {
    expect(isDeliveryEvidence({ evidenceType: 'APPLIED_TASK' })).toBe(true);
    expect(isDeliveryEvidence({ evidenceType: 'TRANSFER' })).toBe(true);
    expect(isDeliveryEvidence({ evidenceType: 'BASELINE' })).toBe(false);
    expect(isDeliveryEvidence({ evidenceType: 'DELAYED_RETEST' })).toBe(false);
  });
});

describe('周复盘完整性', () => {
  const full = {
    focusQuestion: '能否在 2 分钟内用英文说明本周主要障碍？',
    inputText: '看了一篇 TED 讲稿',
    outputText: '录了一段 1 分 40 秒的口语',
    feedbackText: '流利度提升，但冠词错误仍多',
    nextDecision: '下周做 3 次影子跟读',
  };

  it('空记录缺全部五个必填槽位，迁移证据不在必填内', () => {
    const missing = weeklyFocusMissingSlots({
      focusQuestion: '',
      inputText: null,
      outputText: ' ',
      feedbackText: null,
      nextDecision: null,
    });
    expect(missing).toEqual(['question', 'input', 'output', 'feedback', 'decision']);
    expect(missing).not.toContain('transfer');
  });

  it('填满后可以标记已复盘（迁移证据可后补）', () => {
    expect(canReviewWeeklyFocus(full).ok).toBe(true);
  });

  it('缺少下周决定时拒绝并提示中文槽位名', () => {
    const gate = canReviewWeeklyFocus({ ...full, nextDecision: '' });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain('下周决定');
  });

  it('已填槽位数量按输入/输出/反馈/迁移证据统计', () => {
    expect(
      weeklyFocusFilledSlots({
        inputText: 'a',
        outputText: 'b',
        feedbackText: null,
        transferEvidenceId: 'ev1',
      }),
    ).toBe(3);
    expect(
      weeklyFocusFilledSlots({
        inputText: null,
        outputText: null,
        feedbackText: null,
        transferEvidenceId: null,
      }),
    ).toBe(0);
  });
});

describe('buildRecoveryAdvice', () => {
  it('给出 24 小时内的最小下一步，不补积压任务', () => {
    const advice = buildRecoveryAdvice('2026-03-01');
    expect(advice.dueDate).toBe('2026-03-02');
    expect(advice.minimalMinutes).toBe(15);
    expect(advice.message).toContain('不补做积压任务');
    expect(advice.message).toContain('2026-03-02');
  });

  it('中断多天时提示已中断天数', () => {
    const advice = buildRecoveryAdvice('2026-03-01', 5);
    expect(advice.message).toContain('已中断 5 天');
  });
});
