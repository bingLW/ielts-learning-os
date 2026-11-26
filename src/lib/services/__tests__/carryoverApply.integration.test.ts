import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

const { prisma, cleanup } = await createTestDb();
const { applyCarryover, loadOverdueTasks, previewCarryover } = await import('@/lib/services/carryoverApply');
const { carryoverPolicy, carryoverTaskFingerprint } = await import('@/lib/domain/carryover');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-carryover-filter';

async function task(id: string, overrides: Record<string, unknown> = {}) {
  await prisma.planTask.create({
    data: {
      id,
      stageId: STAGE_ID,
      planDate: '2026-11-24',
      module: 'READING',
      skill: 'READING',
      primarySkill: 'READING',
      plannedMinutes: 30,
      actualMinutes: 0,
      status: 'MISSED',
      priority: 'P0',
      sourceKind: 'CORE',
      splittable: true,
      minChunkMinutes: 5,
      planVersion: 1,
      timerStatus: 'IDLE',
      ...overrides,
    },
  });
}

async function session(taskId: string, id: string, activeMinutes: number, terminatedReason: string) {
  await prisma.studySession.create({
    data: {
      id,
      taskId,
      startedAt: new Date('2026-11-24T01:00:00Z'),
      endedAt: new Date('2026-11-24T01:30:00Z'),
      activeMinutes,
      terminatedReason,
      sessionDate: '2026-11-24',
      skill: 'READING',
    },
  });
}

beforeAll(async () => {
  await prisma.stage.create({ data: { id: STAGE_ID, code: 'CARRYOVER_FILTER', nameZh: '滚存过滤测试', estDaysMin: 30, status: 'ACTIVE' } });
  await task('has-effective-time');
  await session('has-effective-time', 'session-effective', 20, 'COMPLETED');
  await task('session-over-snapshot', { plannedMinutes: 60, actualMinutes: 20 });
  await session('session-over-snapshot', 'session-over-snapshot', 30, 'COMPLETED');
  await task('done-by-session', { plannedMinutes: 20 });
  await session('done-by-session', 'session-done', 20, 'COMPLETED');
  await task('abandoned-session', { plannedMinutes: 20 });
  await session('abandoned-session', 'session-abandoned', 20, 'ABANDONED');
  await task('timeout-session', { plannedMinutes: 20 });
  await session('timeout-session', 'session-timeout', 20, 'TIMEOUT');
  await task('running', { timerStatus: 'RUNNING' });
  await task('deferred', { status: 'DEFERRED' });
  await task('done', { status: 'DONE' });
  await task('cancelled', { status: 'CANCELLED' });
  await task('future', { planDate: AS_OF });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('v2.7.1 阶段 C：滚存来源过滤', () => {
  it('只读取过去未完成且计时空闲的任务，有效实际分钟取任务与有效会话较大值', async () => {
    const before = await prisma.planTask.findMany({ orderBy: { id: 'asc' } });
    const value = await previewCarryover(AS_OF, 100);
    const ids = value.decisions.map((decision) => decision.taskId).sort();

    expect(ids).toEqual(['abandoned-session', 'has-effective-time', 'session-over-snapshot', 'timeout-session']);
    expect(value.decisions.find((decision) => decision.taskId === 'has-effective-time')).toMatchObject({ plannedMinutes: 30, actualMinutes: 20, remainingMinutes: 10 });
    expect(value.decisions.find((decision) => decision.taskId === 'session-over-snapshot')).toMatchObject({ plannedMinutes: 60, actualMinutes: 30, remainingMinutes: 30 });
    expect(value.decisions.find((decision) => decision.taskId === 'abandoned-session')).toMatchObject({ actualMinutes: 0, remainingMinutes: 20 });
    expect(await prisma.planTask.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('连续两次滚存只扣一次历史实际分钟，旧周期会话不进入新周期', async () => {
    await prisma.studySession.deleteMany();
    await prisma.planTask.deleteMany();
    await task('repeat-deduction', { plannedMinutes: 60, actualMinutes: 20 });
    await session('repeat-deduction', 'session-repeat', 30, 'COMPLETED');

    const firstOverdue = await loadOverdueTasks(AS_OF);
    const firstTask = firstOverdue.find((item) => item.taskId === 'repeat-deduction');
    expect(firstTask).toMatchObject({ plannedMinutes: 60, actualMinutes: 30 });
    const firstPolicy = carryoverPolicy({ asOfDate: AS_OF, overdue: [firstTask!], budgetMinutes: 200 });
    const first = await applyCarryover({
      targetDate: AS_OF,
      decisions: firstPolicy.decisions,
      expectedFingerprint: carryoverTaskFingerprint([firstTask!]),
    });
    expect(first.ok).toBe(true);
    expect(await prisma.planTask.findUniqueOrThrow({ where: { id: 'repeat-deduction' } })).toMatchObject({
      planDate: AS_OF,
      plannedMinutes: 30,
      actualMinutes: 0,
      movedCount: 1,
    });

    const secondOverdue = await loadOverdueTasks('2026-11-26');
    const secondTask = secondOverdue.find((item) => item.taskId === 'repeat-deduction');
    expect(secondTask).toMatchObject({ planDate: AS_OF, plannedMinutes: 30, actualMinutes: 0 });
    const secondPolicy = carryoverPolicy({ asOfDate: '2026-11-26', overdue: [secondTask!], budgetMinutes: 200 });
    const second = await applyCarryover({
      targetDate: '2026-11-26',
      decisions: secondPolicy.decisions,
      expectedFingerprint: carryoverTaskFingerprint([secondTask!]),
    });
    expect(second.ok).toBe(true);
    expect(await prisma.planTask.findUniqueOrThrow({ where: { id: 'repeat-deduction' } })).toMatchObject({
      planDate: '2026-11-26',
      plannedMinutes: 30,
      actualMinutes: 0,
      movedCount: 2,
    });
  });

  it('决策 ID 重复或缺失时拒绝写入', async () => {
    await task('decision-set', { plannedMinutes: 10 });
    const overdue = await loadOverdueTasks(AS_OF);
    const taskInput = overdue.find((item) => item.taskId === 'decision-set');
    expect(taskInput).toBeDefined();
    const policy = carryoverPolicy({ asOfDate: AS_OF, overdue: [taskInput!], budgetMinutes: 100 });
    const fingerprint = carryoverTaskFingerprint([taskInput!]);

    await expect(applyCarryover({
      targetDate: AS_OF,
      decisions: [policy.decisions[0], policy.decisions[0]],
      expectedFingerprint: fingerprint,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(applyCarryover({
      targetDate: AS_OF,
      decisions: [],
      expectedFingerprint: fingerprint,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await prisma.planTask.findUniqueOrThrow({ where: { id: 'decision-set' } })).movedCount).toBe(0);
  });
});
