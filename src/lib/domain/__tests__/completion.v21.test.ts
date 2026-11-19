/**
 * v2.1 完成率分母口径测试。
 *
 * 锁定的两条不变量（改动前先看这里）：
 * 1. `CANCELLED` / `DEFERRED` 不进入分母 —— 否则休息日与短时预算会被判成失败；
 * 2. 顺延任务只在目标日计一次，原日剔除 —— 否则同一条任务被统计两次。
 */

import { describe, expect, test } from 'vitest';
import { completionRate, isCountableForDate, isRateEligible } from '../completion';
import type { CompletionItem, TaskStatus } from '../../types';

const item = (overrides: Partial<CompletionItem> = {}): CompletionItem => ({
  plannedMinutes: 30,
  actualMinutes: 0,
  status: 'TODO' as TaskStatus,
  ...overrides,
});

describe('isRateEligible', () => {
  test('TODO / IN_PROGRESS / DONE / PARTIAL / MISSED 进入分母', () => {
    for (const status of ['TODO', 'IN_PROGRESS', 'DONE', 'PARTIAL', 'MISSED'] as TaskStatus[]) {
      expect(isRateEligible(item({ status }))).toBe(true);
    }
  });

  test('CANCELLED 与 DEFERRED 不进入分母', () => {
    expect(isRateEligible(item({ status: 'CANCELLED' }))).toBe(false);
    expect(isRateEligible(item({ status: 'DEFERRED' }))).toBe(false);
  });
});

describe('completionRate 分母口径', () => {
  test('取消与延期不拉低完成率', () => {
    const result = completionRate([
      item({ status: 'DONE', actualMinutes: 30 }),
      item({ status: 'CANCELLED', plannedMinutes: 40 }),
      item({ status: 'DEFERRED', plannedMinutes: 50 }),
    ]);
    expect(result.byTime).toBe(1);
    expect(result.byCount).toBe(1);
  });

  test('只有取消/延期时返回 null 而不是 0', () => {
    const result = completionRate([
      item({ status: 'CANCELLED' }),
      item({ status: 'DEFERRED' }),
    ]);
    expect(result.byTime).toBeNull();
    expect(result.byCount).toBeNull();
  });

  test('未完成任务仍计入分母并拉低完成率', () => {
    const result = completionRate([
      item({ status: 'DONE', actualMinutes: 30, plannedMinutes: 30 }),
      item({ status: 'MISSED', plannedMinutes: 30 }),
    ]);
    expect(result.byTime).toBe(0.5);
    expect(result.byCount).toBe(0.5);
  });
});

describe('顺延归属', () => {
  test('原日剔除以 movedFromDate 判定', () => {
    const moved = item({ movedFromDate: '2026-11-18', movedToDate: '2026-11-19' });
    expect(isCountableForDate(moved, '2026-11-18')).toBe(false);
    expect(isCountableForDate(moved, '2026-11-19')).toBe(true);
  });

  test('同一条顺延任务在两周聚合中只计一次', () => {
    const tasks = [
      item({ status: 'TODO', plannedMinutes: 30, movedFromDate: '2026-11-18', movedToDate: '2026-11-19' }),
      item({ status: 'DONE', plannedMinutes: 30, actualMinutes: 30 }),
    ];
    const originalDay = completionRate(tasks, '2026-11-18');
    // 原日只剩那条 DONE，分母 30，完成率 100%
    expect(originalDay.byTime).toBe(1);
    // 目标日两条都算，分母 60，分子 30
    expect(completionRate(tasks, '2026-11-19')?.byTime ?? null).toBe(0.5);
  });
});
