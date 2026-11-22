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

  it('预算为 0 表示关闭付费调用：有支出即超限，无支出不触发', () => {
    const zero = { dailyBudgetUsd: 0, monthlyBudgetUsd: 0, warnPercent: 80 };
    expect(evaluateBudget({ dailyUsd: 0, monthlyUsd: 0 }, zero).state).toBe('OK');
    expect(evaluateBudget({ dailyUsd: 0.01, monthlyUsd: 0 }, zero).state).toBe('EXCEEDED');
    expect(evaluateBudget({ dailyUsd: 0, monthlyUsd: 0.01 }, zero).state).toBe('EXCEEDED');
  });

  it('预算窗口从当天 0 点与当月 1 日开始', () => {
    const { dayStart, monthStart } = budgetWindows(new Date(2026, 10, 22, 15, 30));
    expect(dayStart.getDate()).toBe(22);
    expect(dayStart.getHours()).toBe(0);
    expect(monthStart.getMonth()).toBe(10);
    expect(monthStart.getDate()).toBe(1);
  });
});