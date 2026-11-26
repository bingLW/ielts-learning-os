import { describe, expect, it } from 'vitest';
import {
  budgetConfigFrom,
  budgetWindows,
  estimateCostUsd,
  estimateTokens,
  evaluateBudget,
} from '../meter';

describe('Token 与成本估算', () => {
  it('空文本为 0，其余按字符数 / 3 向上取整', () => {
    expect(estimateTokens('   ')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens('abcdefg')).toBe(3);
  });

  it('成本按每百万 token 单价计算并保留 6 位小数', () => {
    const prices = { inputPricePerMtok: 2, outputPricePerMtok: 6 };
    expect(estimateCostUsd(1_000_000, 0, prices)).toBe(2);
    expect(estimateCostUsd(0, 1_000_000, prices)).toBe(6);
    expect(estimateCostUsd(500_000, 500_000, prices)).toBe(4);
    expect(estimateCostUsd(1, 1, prices)).toBe(0.000008);
  });
});

describe('预算判断', () => {
  const config = { dailyBudgetUsd: 1, monthlyBudgetUsd: 20, warnPercent: 80 };

  it('缺省设置回落到默认预算', () => {
    expect(budgetConfigFrom(null)).toEqual({
      dailyBudgetUsd: 1,
      monthlyBudgetUsd: 20,
      warnPercent: 80,
    });
    expect(
      budgetConfigFrom({ dailyBudgetUsd: 0, monthlyBudgetUsd: 5, warnPercent: 50 }),
    ).toEqual({ dailyBudgetUsd: 0, monthlyBudgetUsd: 5, warnPercent: 50 });
  });

  it('未达预警比例时为 OK', () => {
    const result = evaluateBudget({ dailyUsd: 0.1, monthlyUsd: 2 }, config);
    expect(result.state).toBe('OK');
    expect(result.dailyPercent).toBe(10);
    expect(result.monthlyPercent).toBe(10);
  });

  it('达到预警比例为 WARN，达到上限为 EXCEEDED', () => {
    expect(evaluateBudget({ dailyUsd: 0.8, monthlyUsd: 2 }, config).state).toBe('WARN');
    expect(evaluateBudget({ dailyUsd: 1, monthlyUsd: 2 }, config).state).toBe('EXCEEDED');
    expect(evaluateBudget({ dailyUsd: 0.1, monthlyUsd: 20 }, config).state).toBe('EXCEEDED');
  });

  it('预算为 0 表示关闭外部付费调用：首次调用也超限', () => {
    const zero = { dailyBudgetUsd: 0, monthlyBudgetUsd: 0, warnPercent: 80 };
    expect(evaluateBudget({ dailyUsd: 0, monthlyUsd: 0 }, zero).state).toBe('EXCEEDED');
    expect(evaluateBudget({ dailyUsd: 0.01, monthlyUsd: 0 }, zero).state).toBe('EXCEEDED');
    expect(evaluateBudget({ dailyUsd: 0, monthlyUsd: 0.01 }, zero).state).toBe('EXCEEDED');
  });

  it('浮点恰好达到预算仍判超限', () => {
    expect(evaluateBudget({ dailyUsd: 0.1 + 0.2, monthlyUsd: 0 }, {
      dailyBudgetUsd: 0.3,
      monthlyBudgetUsd: 20,
      warnPercent: 80,
    }).state).toBe('EXCEEDED');
  });

  it('默认时区保持 TZ_NAME，按当地日/月起点返回 UTC 瞬时', () => {
    const { dayStart, monthStart } = budgetWindows(new Date('2026-11-22T15:30:00Z'));
    expect(dayStart.toISOString()).toBe('2026-11-21T16:00:00.000Z');
    expect(monthStart.toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });

  it('跨午夜与跨月按用户 IANA 时区解释', () => {
    const before = budgetWindows(new Date('2026-06-01T06:59:59.999Z'), 'America/Phoenix');
    expect(before.dayStart.toISOString()).toBe('2026-05-31T07:00:00.000Z');
    expect(before.monthStart.toISOString()).toBe('2026-05-01T07:00:00.000Z');
    const after = budgetWindows(new Date('2026-06-01T07:00:00.000Z'), 'America/Phoenix');
    expect(after.dayStart.toISOString()).toBe('2026-06-01T07:00:00.000Z');
    expect(after.monthStart.toISOString()).toBe('2026-06-01T07:00:00.000Z');
  });

  it('纽约 DST 前后使用不同的 UTC 起点', () => {
    const spring = budgetWindows(new Date('2026-03-08T12:00:00Z'), 'America/New_York');
    expect(spring.dayStart.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(spring.monthStart.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    const autumn = budgetWindows(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
    expect(autumn.dayStart.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(autumn.monthStart.toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });

  it('午夜发生 DST 跳钟时取目标当地日期最早有效瞬时', () => {
    const windows = budgetWindows(new Date('2026-09-06T12:00:00Z'), 'America/Santiago');
    expect(windows.dayStart.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(windows.monthStart.toISOString()).toBe('2026-09-01T04:00:00.000Z');
  });
});