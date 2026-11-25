/**
 * T08 AC-11 ⑦⑧⑨ —— `carryoverPolicy()` 纯函数。
 *
 * - ⑦ C1：`movedCount >= ruleMaxMoves` → ABANDON
 * - ⑧ C2/C3：P0 逾期 ≤3 天 → PROMOTE；>3 天 → DEMOTE 到 P1
 * - ⑨ 单日上限：条数 ≤ maxPerDay 且分钟 ≤ 预算 × maxMinutesRatio，超出转 BACKLOG 并 warning
 */

import { describe, expect, test } from 'vitest';
import { carryoverPolicy, type OverdueTask } from '../carryover';
import type { ModuleId, TaskPriority } from '../../types';

function makeOverdue(overrides: Partial<OverdueTask> = {}): OverdueTask {
  return {
    taskId: `t-${Math.random().toString(36).slice(2, 8)}`,
    module: 'LISTENING' as ModuleId,
    priority: 'P1' as TaskPriority,
    plannedMinutes: 10,
    actualMinutes: 0,
    status: 'MISSED',
    planDate: '2026-11-20',
    movedCount: 0,
    splittable: true,
    minChunkMinutes: 5,
    deferReason: null,
    ...overrides,
  };
}

describe('carryoverPolicy C1–C7', () => {
  test('⑦ C1：movedCount >= ruleMaxMoves（2）→ ABANDON', () => {
    const task = makeOverdue({ taskId: 'c1', movedCount: 2, priority: 'P1' });
    const result = carryoverPolicy({
      asOfDate: '2026-11-25',
      overdue: [task],
      budgetMinutes: 60,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].verdict.action).toBe('ABANDON');
    expect(result.abandonedCount).toBe(1);
    if (result.decisions[0].verdict.action === 'ABANDON') {
      expect(result.decisions[0].verdict.reason).toContain('已顺延 2 次达上限');
    }
  });

  test('⑧ P0 逾期 2 天 → PROMOTE 到 P0', () => {
    const task = makeOverdue({ taskId: 'p0a', priority: 'P0', planDate: '2026-11-23' });
    const result = carryoverPolicy({
      asOfDate: '2026-11-25',
      overdue: [task],
      budgetMinutes: 60,
    });

    expect(result.decisions[0].verdict).toMatchObject({ action: 'PROMOTE', toPriority: 'P0' });
    expect(result.promotedCount).toBe(1);
    expect(result.decisions[0].overdueDays).toBe(2);
  });

  test('⑧ P0 逾期 5 天 → DEMOTE 到 P1', () => {
    const task = makeOverdue({ taskId: 'p0b', priority: 'P0', planDate: '2026-11-20' });
    const result = carryoverPolicy({
      asOfDate: '2026-11-25',
      overdue: [task],
      budgetMinutes: 60,
    });

    expect(result.decisions[0].verdict).toMatchObject({ action: 'DEMOTE', toPriority: 'P1' });
    expect(result.demotedCount).toBe(1);
    expect(result.decisions[0].overdueDays).toBe(5);
  });

  test('C4：可拆分且做了一半 → PROMOTE 回原级', () => {
    const task = makeOverdue({
      taskId: 'c4',
      priority: 'P2',
      plannedMinutes: 30,
      actualMinutes: 10,
      splittable: true,
    });
    const result = carryoverPolicy({
      asOfDate: '2026-11-25',
      overdue: [task],
      // 预算给足，让 30 分钟尾巴不被单日上限（60×0.25=15）挤回 BACKLOG
      budgetMinutes: 200,
    });

    expect(result.decisions[0].verdict).toMatchObject({ action: 'PROMOTE', toPriority: 'P2' });
    if (result.decisions[0].verdict.action === 'PROMOTE') {
      expect(result.decisions[0].verdict.reason).toContain('已完成 10/30 分钟');
    }
  });

  test('C5：整块不可拆且已顺延 1 次 → BACKLOG', () => {
    const task = makeOverdue({
      taskId: 'c5',
      priority: 'P1',
      splittable: false,
      movedCount: 1,
      minChunkMinutes: 20,
    });
    const result = carryoverPolicy({
      asOfDate: '2026-11-25',
      overdue: [task],
      budgetMinutes: 60,
    });

    expect(result.decisions[0].verdict.action).toBe('BACKLOG');
    expect(result.backlogCount).toBe(1);
  });

  test('C7：P3 拓展 → ABANDON', () => {
    const task = makeOverdue({ taskId: 'c7', priority: 'P3' });
    const result = carryoverPolicy({
      asOfDate: '2026-11-25',
      overdue: [task],
      budgetMinutes: 60,
    });

    expect(result.decisions[0].verdict.action).toBe('ABANDON');
  });
});

describe('carryoverPolicy 单日上限（⑨）', () => {
  test('条数上限：超过 maxPerDay(3) 的 PROMOTE 转 BACKLOG 并 warning', () => {
    const overdue = Array.from({ length: 5 }, (_, i) =>
      makeOverdue({
        taskId: `cap-${i}`,
        priority: 'P0',
        planDate: '2026-11-24',
        plannedMinutes: 5,
      }),
    );

    const result = carryoverPolicy({
      asOfDate: '2026-11-25',
      overdue,
      budgetMinutes: 100,
      maxPerDay: 3,
      maxMinutesRatio: 0.25,
    });

    // 5 条 PROMOTE，只留 3 条，2 条溢出转 BACKLOG
    expect(result.promotedCount).toBe(3);
    expect(result.overflowCount).toBe(2);
    expect(result.backlogCount).toBe(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('2 项任务因过载上限进入 backlog');

    const overflow = result.decisions.filter((d) => d.verdict.action === 'BACKLOG');
    expect(overflow.every((d) => d.verdict.action === 'BACKLOG' && d.verdict.reason.includes('单日滚存上限'))).toBe(true);
  });

  test('分钟上限：超过预算 × 0.25 的 PROMOTE 转 BACKLOG', () => {
    const overdue = [
      makeOverdue({ taskId: 'm1', priority: 'P0', planDate: '2026-11-24', plannedMinutes: 20 }),
      makeOverdue({ taskId: 'm2', priority: 'P0', planDate: '2026-11-23', plannedMinutes: 20 }),
    ];

    const result = carryoverPolicy({
      asOfDate: '2026-11-25',
      overdue,
      budgetMinutes: 40, // 上限 10 分钟
      maxPerDay: 3,
      maxMinutesRatio: 0.25,
    });

    // 第一条 20 分钟已超过 10 分钟上限 → 全部溢出
    expect(result.promotedCount).toBe(0);
    expect(result.overflowCount).toBe(2);
    expect(result.warnings[0]).toContain('2 项任务因过载上限进入 backlog');
  });
});
