import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import { addDays, today } from '@/lib/date';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb();
const { generatePlanAction, generateAdaptivePlanAction, updatePlanTaskAction } = await import('@/lib/actions/plan');
const { replanDailyTasksAction } = await import('@/lib/actions/replan');
const { addRetestToPlanAction } = await import('@/lib/actions/retest');

const STAGE_ID = 'entry-stage';
const PLAN_DATE = today();
const EDIT_DATE = addDays(PLAN_DATE, 1);
const SCHEDULE_ID = 'entry-retest';

beforeAll(async () => {
  await prisma.stage.create({
    data: { id: STAGE_ID, code: 'S3_B1_IELTS', nameZh: '入口测试阶段', estDaysMin: 30, status: 'ACTIVE' },
  });
  await prisma.resource.create({
    data: { id: 'resource-1', name: '入口测试资源', subject: 'READING', type: 'BOOK' },
  });
  await prisma.dailyBudget.create({
    data: { date: PLAN_DATE, plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.dailyBudget.create({
    data: { date: EDIT_DATE, plannedAvailableMinutes: 30, isRestDay: false, source: 'USER' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('v2.7.1 统一计划入口', () => {
  it('旧固定、自适应生成与旧重排入口均拒绝写入', async () => {
    const tasksBefore = await prisma.planTask.count();
    const versionsBefore = await prisma.planVersion.count();
    const fixed = await generatePlanAction({ planDate: PLAN_DATE, dailyMinutes: 240 });
    const adaptive = await generateAdaptivePlanAction({ planDate: PLAN_DATE, dailyMinutes: 60 });
    const replan = await replanDailyTasksAction({ planDate: PLAN_DATE, newBudgetMinutes: 60 });
    for (const result of [fixed, adaptive, replan]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PRECONDITION');
        expect(result.error).toContain('/planner/');
      }
    }
    expect(await prisma.planTask.count()).toBe(tasksBefore);
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
  });

  it('任务编辑保留未提交字段，预算拒绝零写，成功时写版本', async () => {
    const task = await prisma.planTask.create({
      data: {
        id: 'edit-task', stageId: STAGE_ID, planDate: EDIT_DATE, module: 'READING', skill: 'READING',
        plannedMinutes: 20, status: 'TODO', planVersion: 1, resourceId: 'resource-1', note: '原备注',
      },
    });

    const noteOnly = await updatePlanTaskAction({ taskId: task.id, note: '新备注' });
    expect(noteOnly.ok).toBe(true);
    const afterNote = await prisma.planTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(afterNote.note).toBe('新备注');
    expect(afterNote.resourceId).toBe('resource-1');
    expect(afterNote.planVersion).toBe(1);
    expect(await prisma.planVersion.count({ where: { planDate: EDIT_DATE } })).toBe(0);

    const rejected = await updatePlanTaskAction({ taskId: task.id, plannedMinutes: 40 });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('PRECONDITION');
    expect((await prisma.planTask.findUniqueOrThrow({ where: { id: task.id } })).plannedMinutes).toBe(20);
    expect(await prisma.planVersion.count({ where: { planDate: EDIT_DATE } })).toBe(0);

    const accepted = await updatePlanTaskAction({ taskId: task.id, plannedMinutes: 25, resourceId: '' });
    expect(accepted.ok).toBe(true);
    const afterMinutes = await prisma.planTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(afterMinutes.plannedMinutes).toBe(25);
    expect(afterMinutes.resourceId).toBeNull();
    expect(afterMinutes.planVersion).toBe(2);
    const version = await prisma.planVersion.findFirstOrThrow({
      where: { planDate: EDIT_DATE, version: 2 },
    });
    expect(version.changeSource).toBe('MANUAL_ADJUST');
    expect(JSON.parse(version.afterSnapshot ?? '{}').changedTaskId).toBe(task.id);
  });

  it('复测加入计划受预算约束，并与排期关联、版本审计同事务且幂等', async () => {
    const evidence = await prisma.evidenceRecord.create({
      data: { id: 'entry-evidence', skill: 'LISTENING', evidenceType: 'BASELINE', outputText: '听到关键信息' },
    });
    await prisma.retestSchedule.create({
      data: {
        id: SCHEDULE_ID, parentEvidenceId: evidence.id, retestType: 'IMMEDIATE', dueDate: PLAN_DATE,
        estMinutes: 30, idempotencyKey: 'entry-retest-key',
      },
    });
    await prisma.planTask.create({
      data: {
        id: 'existing-today', stageId: STAGE_ID, planDate: PLAN_DATE, module: 'READING', skill: 'READING',
        plannedMinutes: 45, status: 'TODO', planVersion: 1,
      },
    });

    const tasksBefore = await prisma.planTask.count({ where: { planDate: PLAN_DATE } });
    const versionsBefore = await prisma.planVersion.count({ where: { planDate: PLAN_DATE } });
    const rejected = await addRetestToPlanAction({ scheduleId: SCHEDULE_ID });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('PRECONDITION');
    expect(await prisma.planTask.count({ where: { planDate: PLAN_DATE } })).toBe(tasksBefore);
    expect(await prisma.planVersion.count({ where: { planDate: PLAN_DATE } })).toBe(versionsBefore);
    expect((await prisma.retestSchedule.findUniqueOrThrow({ where: { id: SCHEDULE_ID } })).planTaskId).toBeNull();

    await prisma.planTask.update({ where: { id: 'existing-today' }, data: { plannedMinutes: 15 } });
    const accepted = await addRetestToPlanAction({ scheduleId: SCHEDULE_ID });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const schedule = await prisma.retestSchedule.findUniqueOrThrow({ where: { id: SCHEDULE_ID } });
    expect(schedule.planTaskId).toBe(accepted.data.planTaskId);
    const retestTask = await prisma.planTask.findUniqueOrThrow({ where: { id: accepted.data.planTaskId } });
    expect(retestTask.plannedMinutes).toBe(30);
    expect(retestTask.planVersion).toBe(2);
    const version = await prisma.planVersion.findFirstOrThrow({
      where: { planDate: PLAN_DATE, version: 2 },
    });
    expect(version.reason).toContain('复测');
    expect(version.idempotencyKey).toBe(`retest:${SCHEDULE_ID}`);

    const replayed = await addRetestToPlanAction({ scheduleId: SCHEDULE_ID });
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.data.planTaskId).toBe(accepted.data.planTaskId);
    expect(await prisma.planTask.count({ where: { planDate: PLAN_DATE } })).toBe(tasksBefore + 1);
    expect(await prisma.planVersion.count({ where: { planDate: PLAN_DATE } })).toBe(versionsBefore + 1);
  });
});
