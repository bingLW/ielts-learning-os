/**
 * v2.1 重排引擎测试（覆盖 T08、T09、T10 场景）。
 */

import { describe, expect, test } from 'vitest';
import { replanDailyTasks, totalPlannedAfterReplan, type ExistingTask } from '../replan';
import type { StageCode } from '../../types';

const makeTask = (overrides: Partial<ExistingTask> = {}): ExistingTask => ({
  id: `task-${Math.random()}`,
  module: 'LISTENING',
  skill: 'LISTENING',
  plannedMinutes: 30,
  actualMinutes: 0,
  status: 'TODO',
  priority: 'P1',
  sourceKind: 'CORE',
  splittable: true,
  minChunkMinutes: 5,
  sortOrder: 0,
  planVersion: 1,
  track: 'GENERAL_ENGLISH',
  primarySkill: 'LISTENING',
  resourceId: null,
  note: null,
  ...overrides,
});

describe('replanDailyTasks', () => {
  test('T08 中途缩短预算：90→45，已完成25分钟', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 30, actualMinutes: 25, status: 'IN_PROGRESS', splittable: true }),
      makeTask({ id: 't2', plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
      makeTask({ id: 't3', plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 45,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // t1: 已发生25，原计划30，剩余5；新预算45，扣t1后剩20，可全保留→newPlanned=30
    const t1Action = result.actions.find((a) => a.taskId === 't1');
    expect(t1Action?.type).toBe('KEEP');

    // t2/t3: 未开始→DEFERRED
    const t2Action = result.actions.find((a) => a.taskId === 't2');
    expect(t2Action?.type).toBe('DEFER');

    // 剩余预算20分钟生成新任务
    expect(result.newTasks.length).toBeGreaterThan(0);
    const totalNew = result.newTasks.reduce((sum, t) => sum + t.plannedMinutes, 0);
    expect(totalNew).toBeLessThanOrEqual(20);

    expect(result.actualMinutesSnapshot).toBe(25);
  });

  test('T09 中途增加预算：30→60', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 60,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // t1未开始→DEFER，全部60分钟重新生成
    const t1Action = result.actions.find((a) => a.taskId === 't1');
    expect(t1Action?.type).toBe('DEFER');

    expect(result.newTasks.length).toBeGreaterThan(0);
    const totalNew = result.newTasks.reduce((sum, t) => sum + t.plannedMinutes, 0);
    expect(totalNew).toBeLessThanOrEqual(60);
  });

  test('T10 部分完成：预估20，实际8，可拆分', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 20, actualMinutes: 8, status: 'IN_PROGRESS', splittable: true }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 20,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // t1: 已发生8，原计划20，剩余12；预算20扣8后剩12，可全保留
    const t1Action = result.actions.find((a) => a.taskId === 't1');
    expect(t1Action?.type).toBe('KEEP');
    expect(result.actualMinutesSnapshot).toBe(8);
  });

  test('已发生超预算：实际30，新预算20', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 30, actualMinutes: 30, status: 'DONE' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 20,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // DONE任务保留，剩余预算为负→不生成新任务
    const t1Action = result.actions.find((a) => a.taskId === 't1');
    expect(t1Action?.type).toBe('KEEP');
    expect(result.newTasks.length).toBe(0);
    expect(result.warnings.some((w) => w.includes('超出新预算'))).toBe(true);
  });

  test('休息日重排：不生成新任务', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 0,
      isRestDay: true,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.newTasks.length).toBe(0);
    expect(result.warnings.some((w) => w.includes('休息日'))).toBe(true);
  });

  test('totalPlannedAfterReplan 计算正确', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 30, actualMinutes: 25, status: 'IN_PROGRESS' }),
      makeTask({ id: 't2', plannedMinutes: 20, actualMinutes: 0, status: 'TODO' }),
    ];
    const actions = [
      { type: 'KEEP' as const, taskId: 't1', reason: '' },
      { type: 'DEFER' as const, taskId: 't2', reason: '' },
    ];
    const newTasks = [
      { ...makeTask({ plannedMinutes: 15 }), planVersion: 2, rationale: '' },
    ];
    const total = totalPlannedAfterReplan(actions, existing, newTasks);
    expect(total).toBe(30 + 15);
  });

  test('T08 剩余预算 = 新预算 − 已发生净时长（不是 − 保留计划）', () => {
    // 计划 90，完成 25 后改为 45：只能再用 20 分钟
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 30, actualMinutes: 25, status: 'IN_PROGRESS', splittable: true }),
      makeTask({ id: 't2', plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 45,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // t1 尾巴 5 分钟保留 → 新任务只剩 45 − 25 − 5 = 15
    expect(result.newTasks.reduce((s, t) => s + t.plannedMinutes, 0)).toBeLessThanOrEqual(15);
    expect(result.remainingBudgetMinutes).toBeLessThanOrEqual(15);
  });

  test('预算不足以覆盖尾巴：缩到已发生，尾巴进 backlog', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 60, actualMinutes: 20, status: 'IN_PROGRESS', splittable: true }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 30,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const shrink = result.actions.find((a) => a.taskId === 't1');
    expect(shrink?.type).toBe('SHRINK');
    if (shrink?.type === 'SHRINK') {
      // 30 − 20 = 10 可用于尾巴，原需 40 → 缩到 30
      expect(shrink.newPlannedMinutes).toBe(30);
    }
    expect(result.backlog.some((b) => b.kind === 'PARTIAL_TAIL' && b.minutes === 30)).toBe(true);
  });

  test('正在计时的任务不被改动', () => {
    const existing: ExistingTask[] = [
      makeTask({
        id: 't1',
        plannedMinutes: 30,
        actualMinutes: 10,
        status: 'IN_PROGRESS',
        splittable: true,
        timerRunning: true,
      }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 20,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.actions.find((a) => a.taskId === 't1')?.type).toBe('KEEP');
    expect(result.warnings.some((w) => w.includes('正在计时'))).toBe(true);
  });

  test('计时中任务的未完成尾巴占用剩余预算，新任务不超排', () => {
    const existing: ExistingTask[] = [
      makeTask({
        id: 't1',
        plannedMinutes: 30,
        actualMinutes: 10,
        status: 'IN_PROGRESS',
        splittable: true,
        timerRunning: true,
      }),
      makeTask({ id: 't2', plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 60,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 60 − 已发生 10 − 冻结尾巴 20 = 30
    expect(result.remainingBudgetMinutes).toBe(30);
    expect(result.newTasks.reduce((s, t) => s + t.plannedMinutes, 0)).toBeLessThanOrEqual(30);
    expect(result.plannedAfterReplan).toBeLessThanOrEqual(60);
  });

  test('不挂任务的学习时长（权威净时长）也从剩余预算里扣除', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 45,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
      actualMinutesToday: 25,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.actualMinutesSnapshot).toBe(25);
    expect(result.remainingBudgetMinutes).toBe(20);
    expect(result.newTasks.reduce((s, t) => s + t.plannedMinutes, 0)).toBeLessThanOrEqual(20);
  });

  test('CANCELLED / DEFERRED 不被重排覆盖，也不产生任何指令', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 'c1', plannedMinutes: 20, status: 'CANCELLED' }),
      makeTask({ id: 'd1', plannedMinutes: 20, status: 'DEFERRED' }),
      makeTask({ id: 'm1', plannedMinutes: 20, status: 'MISSED' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 30,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const id of ['c1', 'd1', 'm1']) {
      expect(result.actions.find((a) => a.taskId === id)).toBeUndefined();
    }
  });

  test('重排后计划总量不超过新预算（已发生未超预算时）', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 30, actualMinutes: 10, status: 'IN_PROGRESS', splittable: true }),
      makeTask({ id: 't2', plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
      makeTask({ id: 't3', plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 60,
      planInput: { stageCode: 'S1_A0_A2' as StageCode, allocation: null },
      nextVersion: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plannedAfterReplan).toBeLessThanOrEqual(60);
  });
});

describe('v2.2 复测与重排融合', () => {
  test('到期复测计入剩余预算，并回传待关联的排期 ID', () => {
    const existing: ExistingTask[] = [makeTask({ id: 't1', plannedMinutes: 30 })];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 60,
      planInput: {
        stageCode: 'S1_A0_A2' as StageCode,
        allocation: null,
        dueRetests: { items: [{ id: 'r1', minutes: 10 }] },
      },
      nextVersion: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheduledRetestIds).toEqual(['r1']);
    const retest = result.newTasks.find((task) => task.module === 'EVIDENCE_RETEST');
    expect(retest).toBeDefined();
    expect(retest!.sourceKind).toBe('RETEST');
    expect(retest!.priority).toBe('P0');
    const totalNew = result.newTasks.reduce((sum, task) => sum + task.plannedMinutes, 0);
    expect(totalNew).toBeLessThanOrEqual(60);
    // 重排本身仍保留既有任务处置：未开始的 t1 被延期，不删除
    expect(result.actions.find((action) => action.taskId === 't1')?.type).toBe('DEFER');
  });

  test('已发生时长占用预算后，复测只拿剩余部分；放不下就顺延', () => {
    const existing: ExistingTask[] = [
      makeTask({ id: 't1', plannedMinutes: 30, actualMinutes: 55, status: 'IN_PROGRESS' }),
    ];
    const result = replanDailyTasks({
      existingTasks: existing,
      newBudgetMinutes: 60,
      planInput: {
        stageCode: 'S1_A0_A2' as StageCode,
        allocation: null,
        dueRetests: { items: [{ id: 'r1', minutes: 10 }] },
      },
      nextVersion: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 已发生 55 分钟 → 剩余 5 分钟，10 分钟的复测整项顺延
    expect(result.scheduledRetestIds).toEqual([]);
    expect(result.newTasks.some((task) => task.module === 'EVIDENCE_RETEST')).toBe(false);
  });
});
