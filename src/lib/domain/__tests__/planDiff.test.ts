/**
 * T08 `diffPlan()` —— 纯 diff 六类判定 + 汇总。
 *
 * 覆盖 ADD / REMOVE / MOVE / RESIZE / PRIORITY_CHANGE / KEEP，
 * 以及 `protected` / `hasChanges` / summary 汇总口径。
 */

import { describe, expect, test } from 'vitest';
import { diffPlan, type DiffRow } from '../planDiff';
import type { ModuleId, TaskPriority } from '../../types';

function row(overrides: Partial<DiffRow> = {}): DiffRow {
  return {
    key: 'k',
    title: '听力精听',
    date: '2026-11-25',
    minutes: 30,
    priority: 'P1' as TaskPriority,
    module: 'LISTENING' as ModuleId,
    reason: 'r',
    ...overrides,
  };
}

describe('diffPlan 六类判定', () => {
  test('ADD：只在 after 出现', () => {
    const diff = diffPlan({
      planDate: '2026-11-25',
      budgetMinutes: 60,
      budgetBeforeMinutes: 60,
      before: [],
      after: [row({ key: 'new' })],
      backlogMinutes: 0,
      warnings: [],
    });

    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].kind).toBe('ADD');
    expect(diff.summary.addedCount).toBe(1);
    expect(diff.hasChanges).toBe(true);
  });

  test('REMOVE：只在 before 出现', () => {
    const diff = diffPlan({
      planDate: '2026-11-25',
      budgetMinutes: 60,
      budgetBeforeMinutes: 60,
      before: [row({ key: 'old' })],
      after: [],
      backlogMinutes: 0,
      warnings: [],
    });

    expect(diff.entries[0].kind).toBe('REMOVE');
    expect(diff.entries[0].after).toBeNull();
    expect(diff.summary.removedCount).toBe(1);
  });

  test('MOVE：同 key 但日期不同', () => {
    const diff = diffPlan({
      planDate: '2026-11-25',
      budgetMinutes: 60,
      budgetBeforeMinutes: 60,
      before: [row({ key: 'k', date: '2026-11-24' })],
      after: [row({ key: 'k', date: '2026-11-25' })],
      backlogMinutes: 0,
      warnings: [],
    });

    expect(diff.entries[0].kind).toBe('MOVE');
    expect(diff.summary.movedCount).toBe(1);
  });

  test('RESIZE：同 key 同日期但分钟不同', () => {
    const diff = diffPlan({
      planDate: '2026-11-25',
      budgetMinutes: 60,
      budgetBeforeMinutes: 60,
      before: [row({ key: 'k', minutes: 50 })],
      after: [row({ key: 'k', minutes: 40 })],
      backlogMinutes: 0,
      warnings: [],
    });

    expect(diff.entries[0].kind).toBe('RESIZE');
    expect(diff.summary.resizedCount).toBe(1);
    expect(diff.entries[0].before?.minutes).toBe(50);
    expect(diff.entries[0].after?.minutes).toBe(40);
  });

  test('PRIORITY_CHANGE：同 key 同日期同分钟但优先级不同', () => {
    const diff = diffPlan({
      planDate: '2026-11-25',
      budgetMinutes: 60,
      budgetBeforeMinutes: 60,
      before: [row({ key: 'k', priority: 'P1' })],
      after: [row({ key: 'k', priority: 'P2' })],
      backlogMinutes: 0,
      warnings: [],
    });

    expect(diff.entries[0].kind).toBe('PRIORITY_CHANGE');
    expect(diff.summary.priorityChangedCount).toBe(1);
  });

  test('KEEP：完全一致 → hasChanges=false', () => {
    const diff = diffPlan({
      planDate: '2026-11-25',
      budgetMinutes: 60,
      budgetBeforeMinutes: 60,
      before: [row({ key: 'k' })],
      after: [row({ key: 'k' })],
      backlogMinutes: 0,
      warnings: [],
    });

    expect(diff.entries[0].kind).toBe('KEEP');
    expect(diff.summary.keptCount).toBe(1);
    expect(diff.hasChanges).toBe(false);
  });
});

describe('diffPlan 汇总与保护', () => {
  test('protected 行计入 protectedMinutes 且为 KEEP', () => {
    const diff = diffPlan({
      planDate: '2026-11-25',
      budgetMinutes: 60,
      budgetBeforeMinutes: 60,
      before: [row({ key: 'p', minutes: 20, protected: true })],
      after: [row({ key: 'p', minutes: 20 })],
      backlogMinutes: 0,
      warnings: [],
    });

    expect(diff.entries[0].kind).toBe('KEEP');
    expect(diff.entries[0].protected).toBe(true);
    expect(diff.summary.protectedMinutes).toBe(20);
    expect(diff.hasChanges).toBe(false);
  });

  test('summary 正确汇总 plannedBefore/After 与 P0 分钟', () => {
    const diff = diffPlan({
      planDate: '2026-11-25',
      budgetMinutes: 45,
      budgetBeforeMinutes: 90,
      before: [
        row({ key: 'p0', minutes: 20, priority: 'P0' }),
        row({ key: 'p1', minutes: 30, priority: 'P1' }),
      ],
      after: [
        row({ key: 'p0', minutes: 20, priority: 'P0' }),
        row({ key: 'p1', minutes: 10, priority: 'P1' }),
        row({ key: 'new', minutes: 15, priority: 'P1' }),
      ],
      backlogMinutes: 10,
      warnings: ['w1'],
    });

    expect(diff.summary.plannedBefore).toBe(50);
    expect(diff.summary.plannedAfter).toBe(45);
    expect(diff.summary.budget).toBe(45);
    expect(diff.summary.budgetBefore).toBe(90);
    expect(diff.summary.p0MinutesBefore).toBe(20);
    expect(diff.summary.p0MinutesAfter).toBe(20);
    expect(diff.summary.backlogMinutes).toBe(10);
    expect(diff.warnings).toEqual(['w1']);
  });
});
