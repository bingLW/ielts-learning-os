/**
 * T08 AC-10 主证据 —— ①–⑥。
 *
 * - ① `previewReplan` 后 `PlanTask`/`PlanVersion` 行数均不变
 * - ② diff 正确识别 ADD/REMOVE/RESIZE/KEEP（MOVE 由 `planDiff.test.ts` 纯函数覆盖：
 *     `replanDailyTasks` 的 DEFER 是「移出当日」而非「改到另一天」，故集成路径不产 MOVE）
 * - ③ 已完成/计时中任务 `protected=true` 且不参与变更
 * - ④ 预览后手动改一条任务 → `confirmReplan` 返回 `fail('CONFLICT')`（token 失效）
 * - ⑤ 确认后恰好 1 条 `PlanVersion(changeSource='REPLAN', idempotencyKey)`
 * - ⑥ `hasChanges=false` → action 返回 `fail('PRECONDITION')`（禁止空版本）
 * - ⑦ `idempotencyKey` 已被占用 → `fail('CONFLICT')`（第 3 重幂等闸门，直接种记录验证）
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb();

const { previewReplanAction, confirmReplanAction } = await import('@/lib/actions/planner');
const { applyCarryover, loadOverdueTasks } = await import('@/lib/services/carryoverApply');
const { carryoverPolicy, carryoverTaskFingerprint } = await import('@/lib/domain/carryover');

const STAGE_ID = 'stage-replan';
const AS_OF_A = '2026-11-25';
const AS_OF_B = '2026-11-26';
const AS_OF_EMPTY = '2026-11-27';
const AS_OF_IDEM = '2026-11-28';
const AS_OF_LOCK = '2026-11-29';
const AS_OF_LOCK_ACTUAL = '2026-11-30';
const AS_OF_DONE_OVER = '2026-12-01';
const AS_OF_LOCK_OVER = '2026-12-02';
const AS_OF_TIMER = '2026-12-03';
const AS_OF_CARRY_REPLAN = '2026-12-04';

interface TaskSeed {
  id: string;
  planDate: string;
  module: string;
  skill: string;
  plannedMinutes: number;
  actualMinutes: number;
  status: string;
  priority?: string;
  splittable?: boolean;
  timerStatus?: string;
  movedCount?: number;
  movedToDate?: string;
  sortOrder: number;
}

async function createTask(seed: TaskSeed) {
  await prisma.planTask.create({
    data: {
      id: seed.id,
      stageId: STAGE_ID,
      planDate: seed.planDate,
      module: seed.module,
      skill: seed.skill,
      plannedMinutes: seed.plannedMinutes,
      actualMinutes: seed.actualMinutes,
      status: seed.status,
      priority: seed.priority ?? 'P1',
      sourceKind: 'CORE',
      splittable: seed.splittable ?? true,
      minChunkMinutes: 5,
      sortOrder: seed.sortOrder,
      planVersion: 1,
      track: 'GENERAL_ENGLISH',
      primarySkill: seed.module,
      timerStatus: seed.timerStatus ?? 'IDLE',
      movedCount: seed.movedCount ?? 0,
      movedToDate: seed.movedToDate ?? null,
    },
  });
}

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: '重排测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'B1_B2',
    },
  });
  await prisma.plannerSettings.create({
    data: { id: 1, defaultDailyMinutes: 60, minTaskMinutes: 5, isUserConfirmed: true },
  });
  await prisma.dailyBudget.createMany({
    data: [
      { date: AS_OF_A, plannedAvailableMinutes: 90, isRestDay: false, source: 'USER' },
      { date: AS_OF_B, plannedAvailableMinutes: 30, isRestDay: false, source: 'USER' },
      { date: AS_OF_EMPTY, plannedAvailableMinutes: 0, isRestDay: true, source: 'USER' },
      { date: AS_OF_IDEM, plannedAvailableMinutes: 90, isRestDay: false, source: 'USER' },
      { date: AS_OF_LOCK, plannedAvailableMinutes: 20, isRestDay: false, source: 'USER' },
      { date: AS_OF_LOCK_ACTUAL, plannedAvailableMinutes: 100, isRestDay: false, source: 'USER' },
      { date: AS_OF_DONE_OVER, plannedAvailableMinutes: 80, isRestDay: false, source: 'USER' },
      { date: AS_OF_LOCK_OVER, plannedAvailableMinutes: 10, isRestDay: false, source: 'USER' },
      { date: AS_OF_TIMER, plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
      { date: AS_OF_CARRY_REPLAN, plannedAvailableMinutes: 100, isRestDay: false, source: 'USER' },
    ],
  });

  // 场景 A：KEEP(受保护×2) + REMOVE + ADD
  await createTask({ id: 'task-done', planDate: AS_OF_A, module: 'LISTENING', skill: 'LISTENING', plannedMinutes: 20, actualMinutes: 20, status: 'DONE', sortOrder: 0 });
  await createTask({ id: 'task-running', planDate: AS_OF_A, module: 'READING', skill: 'READING', plannedMinutes: 20, actualMinutes: 0, status: 'IN_PROGRESS', timerStatus: 'RUNNING', sortOrder: 1 });
  await createTask({ id: 'task-todo', planDate: AS_OF_A, module: 'WRITING', skill: 'WRITING', plannedMinutes: 30, actualMinutes: 0, status: 'TODO', sortOrder: 2 });

  // 场景 B：RESIZE（进行中可拆，尾巴放不下 → SHRINK）
  await createTask({ id: 'task-shrink', planDate: AS_OF_B, module: 'SPEAKING', skill: 'SPEAKING', plannedMinutes: 50, actualMinutes: 10, status: 'IN_PROGRESS', sortOrder: 0 });
  await createTask({ id: 'task-done-b', planDate: AS_OF_B, module: 'LISTENING', skill: 'LISTENING', plannedMinutes: 20, actualMinutes: 20, status: 'DONE', sortOrder: 1 });

  // 场景 C：hasChanges=false（仅一个已完成任务 + 零预算休息日）
  await createTask({ id: 'task-done-only', planDate: AS_OF_EMPTY, module: 'LISTENING', skill: 'LISTENING', plannedMinutes: 20, actualMinutes: 20, status: 'DONE', sortOrder: 0 });

  // 场景 D：幂等闸门（token 一致 + hasChanges=true，但 idempotencyKey 已被占用）
  await createTask({ id: 'task-idem-done', planDate: AS_OF_IDEM, module: 'LISTENING', skill: 'LISTENING', plannedMinutes: 20, actualMinutes: 20, status: 'DONE', sortOrder: 0 });
  await createTask({ id: 'task-idem-todo', planDate: AS_OF_IDEM, module: 'WRITING', skill: 'WRITING', plannedMinutes: 30, actualMinutes: 0, status: 'TODO', sortOrder: 1 });

  // 场景 E：GENERATE 滚入任务自动锁定，不传 lockedTaskIds 也不能移除
  await createTask({ id: 'task-carried', planDate: AS_OF_LOCK, module: 'READING', skill: 'READING', plannedMinutes: 20, actualMinutes: 0, status: 'TODO', movedCount: 1, movedToDate: AS_OF_LOCK, sortOrder: 0 });
  await createTask({ id: 'task-lock-removable', planDate: AS_OF_LOCK, module: 'WRITING', skill: 'WRITING', plannedMinutes: 20, actualMinutes: 0, status: 'TODO', sortOrder: 1 });

  await createTask({ id: 'task-lock-actual', planDate: AS_OF_LOCK_ACTUAL, module: 'READING', skill: 'READING', plannedMinutes: 40, actualMinutes: 20, status: 'IN_PROGRESS', movedCount: 1, movedToDate: AS_OF_LOCK_ACTUAL, sortOrder: 0 });
  await createTask({ id: 'task-lock-actual-removable', planDate: AS_OF_LOCK_ACTUAL, module: 'WRITING', skill: 'WRITING', plannedMinutes: 20, actualMinutes: 0, status: 'TODO', sortOrder: 1 });
  await createTask({ id: 'task-done-over', planDate: AS_OF_DONE_OVER, module: 'LISTENING', skill: 'LISTENING', plannedMinutes: 20, actualMinutes: 90, status: 'DONE', sortOrder: 0 });
  await createTask({ id: 'task-done-over-todo', planDate: AS_OF_DONE_OVER, module: 'WRITING', skill: 'WRITING', plannedMinutes: 30, actualMinutes: 0, status: 'TODO', sortOrder: 1 });
  await createTask({ id: 'task-lock-over', planDate: AS_OF_LOCK_OVER, module: 'READING', skill: 'READING', plannedMinutes: 20, actualMinutes: 0, status: 'TODO', movedCount: 1, movedToDate: AS_OF_LOCK_OVER, sortOrder: 0 });
  await createTask({ id: 'task-timer', planDate: AS_OF_TIMER, module: 'READING', skill: 'READING', plannedMinutes: 30, actualMinutes: 0, status: 'TODO', sortOrder: 0 });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('T08 重排预览/确认（AC-10）', () => {
  it('① previewReplan 后 PlanTask / PlanVersion 行数均不变', async () => {
    const beforeTasks = await prisma.planTask.count({ where: { planDate: AS_OF_A } });
    const beforeVersions = await prisma.planVersion.count();

    const preview = await previewReplanAction({ planDate: AS_OF_A, newBudgetMinutes: 60 });
    expect(preview.ok).toBe(true);

    expect(await prisma.planTask.count({ where: { planDate: AS_OF_A } })).toBe(beforeTasks);
    expect(await prisma.planVersion.count()).toBe(beforeVersions);
  });

  it('② diff 正确识别 ADD/REMOVE/KEEP（场景 A）与 RESIZE（场景 B）', async () => {
    const previewA = await previewReplanAction({ planDate: AS_OF_A, newBudgetMinutes: 60 });
    expect(previewA.ok).toBe(true);
    if (!previewA.ok) return;

    const kindsA = previewA.data.diff.entries.map((e) => e.kind);
    expect(kindsA).toContain('ADD');
    expect(kindsA).toContain('REMOVE');
    expect(kindsA).toContain('KEEP');

    const removed = previewA.data.diff.entries.find((e) => e.key === 'task-todo');
    expect(removed?.kind).toBe('REMOVE');

    const previewB = await previewReplanAction({ planDate: AS_OF_B, newBudgetMinutes: 30 });
    expect(previewB.ok).toBe(true);
    if (!previewB.ok) return;

    const resized = previewB.data.diff.entries.find((e) => e.key === 'task-shrink');
    expect(resized?.kind).toBe('RESIZE');
    expect(resized?.before?.minutes).toBe(50);
    expect(resized?.after?.minutes).toBe(10);
  });

  it('③ 已完成/计时中任务 protected=true 且不参与变更', async () => {
    const preview = await previewReplanAction({ planDate: AS_OF_A, newBudgetMinutes: 60 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const done = preview.data.diff.entries.find((e) => e.key === 'task-done');
    const running = preview.data.diff.entries.find((e) => e.key === 'task-running');
    expect(done?.protected).toBe(true);
    expect(done?.kind).toBe('KEEP');
    expect(running?.protected).toBe(true);
    expect(running?.kind).toBe('KEEP');
    expect(preview.data.diff.summary.protectedMinutes).toBe(40);
  });

  it('④ 预览后手动改一条任务 → confirmReplan 返回 CONFLICT（token 失效）', async () => {
    const preview = await previewReplanAction({ planDate: AS_OF_A, newBudgetMinutes: 60 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    // 手动改动计划状态（plannedMinutes 进了 token 指纹）
    await prisma.planTask.update({
      where: { id: 'task-todo' },
      data: { plannedMinutes: 31 },
    });

    const confirm = await confirmReplanAction({
      planDate: AS_OF_A,
      newBudgetMinutes: 60,
      previewToken: preview.data.previewToken,
      idempotencyKey: 'conflict-key',
    });
    expect(confirm.ok).toBe(false);
    if (!confirm.ok) expect(confirm.code).toBe('CONFLICT');
  });

  it('⑤ 确认后恰好 1 条 PlanVersion(changeSource=REPLAN, idempotencyKey)', async () => {
    const preview = await previewReplanAction({ planDate: AS_OF_A, newBudgetMinutes: 60 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const confirm = await confirmReplanAction({
      planDate: AS_OF_A,
      newBudgetMinutes: 60,
      previewToken: preview.data.previewToken,
      idempotencyKey: 'confirm-key-1',
    });
    expect(confirm.ok).toBe(true);
    if (!confirm.ok) return;

    const versions = await prisma.planVersion.findMany({ where: { idempotencyKey: 'confirm-key-1' } });
    expect(versions).toHaveLength(1);
    expect(versions[0].changeSource).toBe('REPLAN');
  });

  it('⑥ hasChanges=false → confirmReplan 返回 PRECONDITION（禁止空版本）', async () => {
    const preview = await previewReplanAction({ planDate: AS_OF_EMPTY, newBudgetMinutes: 0, isRestDay: true });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.diff.hasChanges).toBe(false);

    const confirm = await confirmReplanAction({
      planDate: AS_OF_EMPTY,
      newBudgetMinutes: 0,
      isRestDay: true,
      previewToken: preview.data.previewToken,
      idempotencyKey: 'empty-key',
    });
    expect(confirm.ok).toBe(false);
    if (!confirm.ok) expect(confirm.code).toBe('PRECONDITION');
  });

  it('⑧ 滚入任务自动锁定，确认重排后仍保留', async () => {
    const value = await previewReplanAction({ planDate: AS_OF_LOCK, newBudgetMinutes: 20 });
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    const carried = value.data.diff.entries.find((entry) => entry.key === 'task-carried');
    const removable = value.data.diff.entries.find((entry) => entry.key === 'task-lock-removable');
    expect(carried).toMatchObject({ kind: 'KEEP', protected: true });
    expect(removable?.kind).toBe('REMOVE');

    const result = await confirmReplanAction({
      planDate: AS_OF_LOCK,
      newBudgetMinutes: 20,
      previewToken: value.data.previewToken,
      idempotencyKey: 'carried-lock-key',
    });
    expect(result.ok).toBe(true);
    const row = await prisma.planTask.findUniqueOrThrow({ where: { id: 'task-carried' } });
    expect(row).toMatchObject({ planDate: AS_OF_LOCK, status: 'TODO', plannedMinutes: 20, movedCount: 1 });
  });

  it('锁定任务已发生 20 分钟时只预扣 20 分钟尾巴，不重复扣实际分钟', async () => {
    const value = await previewReplanAction({ planDate: AS_OF_LOCK_ACTUAL, newBudgetMinutes: 100 });
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    const addedMinutes = value.data.diff.entries
      .filter((entry) => entry.kind === 'ADD')
      .reduce((sum, entry) => sum + (entry.after?.minutes ?? 0), 0);
    expect(addedMinutes).toBe(60);

    const result = await confirmReplanAction({
      planDate: AS_OF_LOCK_ACTUAL,
      newBudgetMinutes: 100,
      previewToken: value.data.previewToken,
      idempotencyKey: 'lock-actual-key',
    });
    expect(result.ok).toBe(true);
    const version = await prisma.planVersion.findUniqueOrThrow({ where: { idempotencyKey: 'lock-actual-key' } });
    const after = JSON.parse(version.afterSnapshot ?? '{}') as { totalMinutes: number; taskIds: string[] };
    expect(after.totalMinutes).toBe(100);
    expect(after.taskIds).toContain('task-lock-actual');
  });

  it('DONE 任务实际 90 分钟计入最终预算，预算 80 时拒绝确认', async () => {
    const value = await previewReplanAction({ planDate: AS_OF_DONE_OVER, newBudgetMinutes: 80 });
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    const versionsBefore = await prisma.planVersion.count();

    const result = await confirmReplanAction({
      planDate: AS_OF_DONE_OVER,
      newBudgetMinutes: 80,
      previewToken: value.data.previewToken,
      idempotencyKey: 'done-over-key',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PRECONDITION');
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
    expect((await prisma.planTask.findUniqueOrThrow({ where: { id: 'task-done-over-todo' } })).status).toBe('TODO');
  });

  it('锁定任务剩余分钟超过当日预算 → 预览 PRECONDITION', async () => {
    const value = await previewReplanAction({ planDate: AS_OF_LOCK_OVER, newBudgetMinutes: 10 });
    expect(value.ok).toBe(false);
    if (!value.ok) expect(value.code).toBe('PRECONDITION');
  });

  it('预览后 timerVersion 变化 → 确认 CONFLICT', async () => {
    const value = await previewReplanAction({ planDate: AS_OF_TIMER, newBudgetMinutes: 60 });
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    await prisma.planTask.update({
      where: { id: 'task-timer' },
      data: { timerVersion: { increment: 1 } },
    });

    const result = await confirmReplanAction({
      planDate: AS_OF_TIMER,
      newBudgetMinutes: 60,
      previewToken: value.data.previewToken,
      idempotencyKey: 'timer-conflict-key',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONFLICT');
  });

  it('确认事务 P2002/P2028 → CONFLICT 且不落库', async () => {
    const originalTransaction = prisma.$transaction.bind(prisma);
    for (const code of ['P2002', 'P2028']) {
      const value = await previewReplanAction({ planDate: AS_OF_TIMER, newBudgetMinutes: 60 });
      expect(value.ok).toBe(true);
      if (!value.ok) return;
      const versionsBefore = await prisma.planVersion.count();
      const tasksBefore = await prisma.planTask.count({ where: { planDate: AS_OF_TIMER } });
      const transaction = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce({ code });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await confirmReplanAction({
        planDate: AS_OF_TIMER,
        newBudgetMinutes: 60,
        previewToken: value.data.previewToken,
        idempotencyKey: `transaction-${code}`,
      });
      transaction.mockImplementation(originalTransaction);
      errorLog.mockRestore();

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('CONFLICT');
      expect(await prisma.planVersion.count()).toBe(versionsBefore);
      expect(await prisma.planTask.count({ where: { planDate: AS_OF_TIMER } })).toBe(tasksBefore);
    }
  });

  it('⑦ idempotencyKey 已被占用 → confirmReplan 返回 CONFLICT 且不再落库', async () => {
    // 1. 先取一个与当前库状态一致的 token（token 闸门会通过）
    const preview = await previewReplanAction({ planDate: AS_OF_IDEM, newBudgetMinutes: 60 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // 该场景有 REMOVE + ADD，hasChanges=true（PRECONDITION 闸门会通过）
    expect(preview.data.diff.hasChanges).toBe(true);

    // 2. 直接种一条占用幂等键的 PlanVersion（PlanVersion.idempotencyKey 为 @unique），
    //    模拟「同一 key 已被并发/重复提交写过」。
    await prisma.planVersion.create({
      data: {
        planDate: AS_OF_IDEM,
        version: 999,
        changeSource: 'REPLAN',
        idempotencyKey: 'idem-gate-key',
      },
    });

    const tasksBefore = await prisma.planTask.count({ where: { planDate: AS_OF_IDEM } });
    const versionsBefore = await prisma.planVersion.count({ where: { planDate: AS_OF_IDEM } });

    // 3. 同一个 key + 有效 token + hasChanges=true → 应被第 3 重幂等闸门拦截。
    const confirm = await confirmReplanAction({
      planDate: AS_OF_IDEM,
      newBudgetMinutes: 60,
      previewToken: preview.data.previewToken,
      idempotencyKey: 'idem-gate-key',
    });
    expect(confirm.ok).toBe(false);
    if (!confirm.ok) expect(confirm.code).toBe('CONFLICT');

    // 幂等拦截发生在任何写事务之前：PlanTask / PlanVersion 行数不得增加。
    expect(await prisma.planTask.count({ where: { planDate: AS_OF_IDEM } })).toBe(tasksBefore);
    expect(await prisma.planVersion.count({ where: { planDate: AS_OF_IDEM } })).toBe(versionsBefore);
  });

  it('滚存 60 分钟计划/20 分钟实际 → 40/0 后重排只扣 40 分钟尾巴', async () => {
    await prisma.planTask.deleteMany();
    await prisma.studySession.deleteMany();
    await createTask({
      id: 'task-carry-replan',
      planDate: '2026-12-03',
      module: 'READING',
      skill: 'READING',
      plannedMinutes: 60,
      actualMinutes: 20,
      status: 'TODO',
      sortOrder: 0,
    });

    const overdue = await loadOverdueTasks(AS_OF_CARRY_REPLAN);
    const policy = carryoverPolicy({
      asOfDate: AS_OF_CARRY_REPLAN,
      overdue,
      budgetMinutes: 200,
    });
    const applied = await applyCarryover({
      targetDate: AS_OF_CARRY_REPLAN,
      decisions: policy.decisions,
      expectedFingerprint: carryoverTaskFingerprint(overdue),
    });
    expect(applied.ok).toBe(true);
    const carried = await prisma.planTask.findUniqueOrThrow({ where: { id: 'task-carry-replan' } });
    expect(carried).toMatchObject({ plannedMinutes: 40, actualMinutes: 0, movedCount: 1 });

    const value = await previewReplanAction({ planDate: AS_OF_CARRY_REPLAN, newBudgetMinutes: 100 });
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    const addedMinutes = value.data.diff.entries
      .filter((entry) => entry.kind === 'ADD')
      .reduce((sum, entry) => sum + (entry.after?.minutes ?? 0), 0);
    expect(addedMinutes).toBe(60);

    const result = await confirmReplanAction({
      planDate: AS_OF_CARRY_REPLAN,
      newBudgetMinutes: 100,
      previewToken: value.data.previewToken,
      idempotencyKey: 'carry-replan-key',
    });
    expect(result.ok).toBe(true);
    const version = await prisma.planVersion.findUniqueOrThrow({ where: { idempotencyKey: 'carry-replan-key' } });
    expect(JSON.parse(version.afterSnapshot ?? '{}')).toMatchObject({ totalMinutes: 100 });
  });
});
