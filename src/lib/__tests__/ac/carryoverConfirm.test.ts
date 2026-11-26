import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb();
const { generatePlanPreviewAction, confirmPlanVersionAction } = await import('@/lib/actions/planner');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-carryover-confirm';
const INPUT = { purpose: 'GENERATE' as const, asOfDate: AS_OF, horizonDays: 1, stageId: STAGE_ID };
const CARRYOVER_IDS = ['carry-promote', 'carry-demote', 'carry-backlog', 'carry-abandon'];

interface TaskSeed {
  id: string;
  planDate: string;
  plannedMinutes: number;
  actualMinutes?: number;
  status?: string;
  priority: string;
  movedCount?: number;
  splittable?: boolean;
}

async function createTask(seed: TaskSeed) {
  await prisma.planTask.create({
    data: {
      id: seed.id,
      stageId: STAGE_ID,
      planDate: seed.planDate,
      module: seed.id === 'carry-promote' ? 'LISTENING' : 'READING',
      skill: seed.id === 'carry-promote' ? 'LISTENING' : 'READING',
      primarySkill: seed.id === 'carry-promote' ? 'LISTENING' : 'READING',
      plannedMinutes: seed.plannedMinutes,
      actualMinutes: seed.actualMinutes ?? 0,
      status: seed.status ?? 'MISSED',
      priority: seed.priority,
      sourceKind: 'CORE',
      splittable: seed.splittable ?? true,
      minChunkMinutes: 5,
      movedCount: seed.movedCount ?? 0,
      originalScheduledDate: seed.planDate,
      sortOrder: 0,
      planVersion: 1,
      timerStatus: 'IDLE',
    },
  });
}

async function seedCarryover() {
  await createTask({ id: 'carry-promote', planDate: '2026-11-23', plannedMinutes: 30, actualMinutes: 20, priority: 'P0' });
  await createTask({ id: 'carry-demote', planDate: '2026-11-20', plannedMinutes: 5, priority: 'P0' });
  await createTask({ id: 'carry-backlog', planDate: '2026-11-24', plannedMinutes: 10, priority: 'P1', splittable: false });
  await createTask({ id: 'carry-abandon', planDate: '2026-11-24', plannedMinutes: 10, priority: 'P3', movedCount: 2 });
}

async function preview() {
  const result = await generatePlanPreviewAction(INPUT);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function confirmInput(value: Awaited<ReturnType<typeof preview>>) {
  return { ...INPUT, snapshotId: value.snapshotId, previewToken: value.previewToken };
}

beforeAll(async () => {
  await prisma.stage.create({
    data: { id: STAGE_ID, code: 'S3_B1_IELTS', nameZh: '滚存确认测试', estDaysMin: 30, status: 'ACTIVE', profileCode: 'B1_B2' },
  });
  await prisma.skillAllocationProfile.create({
    data: { profileCode: 'B1_B2', listeningPct: 25, readingPct: 25, speakingPct: 25, writingPct: 25, effectiveFrom: '2026-01-01', isActive: true },
  });
  await prisma.plannerSettings.create({ data: { id: 1, defaultDailyMinutes: 100, minTaskMinutes: 5, isUserConfirmed: true } });
  await prisma.dailyBudget.create({ data: { date: AS_OF, plannedAvailableMinutes: 100, isRestDay: false, source: 'USER' } });
  await prisma.learningGoal.create({ data: { goalType: 'GENERAL_ENGLISH', name: '通用英语', status: 'ACTIVE', targetValue: 'B2' } });
  await prisma.egiuLesson.createMany({
    data: Array.from({ length: 5 }, (_, index) => ({
      id: `egiu-carry-${index + 1}`,
      stageId: STAGE_ID,
      unitNo: String(index + 1),
      knowledgePoint: `语法点 ${index + 1}`,
      learnedDate: '2026-01-01',
      currentColor: 'YELLOW',
      nextReviewDate: AS_OF,
    })),
  });
  await prisma.reviewTask.create({
    data: { id: 'review-carry', targetType: 'VOCAB_WORD', targetId: 'word-carry', targetLabel: '词汇复习', intervalCode: 'D1', dueDate: AS_OF, status: 'PENDING', estMinutes: 5 },
  });
});

beforeEach(async () => {
  await prisma.studySession.deleteMany();
  await prisma.planTask.deleteMany();
  await prisma.planVersion.deleteMany();
  await prisma.planningSnapshot.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('v2.7.1 阶段 C：GENERATE carryover action', () => {
  it('预览零写，四类裁决完整，新任务先扣除滚入剩余分钟', async () => {
    await seedCarryover();
    const tasksBefore = await prisma.planTask.count();
    const versionsBefore = await prisma.planVersion.count();
    const snapshotsBefore = await prisma.planningSnapshot.count();
    const gapsBefore = await prisma.skillGap.count();
    const candidatesBefore = await prisma.taskCandidate.count();
    const decisionsBefore = await prisma.taskPriorityDecision.count();

    const value = await preview();

    expect(await prisma.planTask.count()).toBe(tasksBefore);
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
    expect(await prisma.planningSnapshot.count()).toBe(snapshotsBefore);
    expect(await prisma.skillGap.count()).toBe(gapsBefore);
    expect(await prisma.taskCandidate.count()).toBe(candidatesBefore);
    expect(await prisma.taskPriorityDecision.count()).toBe(decisionsBefore);
    expect(value.carryover?.decisions.map((decision) => decision.action).sort()).toEqual(['ABANDON', 'BACKLOG', 'DEMOTE', 'PROMOTE']);
    expect(value.carryover).toMatchObject({ promotedCount: 1, demotedCount: 1, backlogCount: 1, abandonedCount: 1, overflowCount: 0 });
    expect(value.carryover?.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const carriedMinutes = value.carryover!.decisions
      .filter((decision) => decision.action === 'PROMOTE' || decision.action === 'DEMOTE')
      .reduce((sum, decision) => sum + decision.remainingMinutes, 0);
    expect(carriedMinutes).toBe(15);
    const newMinutes = value.days[0].tasks.reduce((sum, task) => sum + task.plannedMinutes, 0);
    expect(newMinutes).toBeGreaterThan(0);
    expect(newMinutes).toBeLessThanOrEqual(100 - carriedMinutes);
  });

  it('确认单事务写入四类去向与版本摘要，重复确认不重复写', async () => {
    await seedCarryover();
    const value = await preview();
    const input = confirmInput(value);

    const first = await confirmPlanVersionAction(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const promote = await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-promote' } });
    expect(promote).toMatchObject({ planDate: AS_OF, movedToDate: AS_OF, plannedMinutes: 10, movedCount: 1, status: 'TODO', priority: 'P0', planVersion: 1 });
    expect(promote.originalScheduledDate).toBe('2026-11-23');
    const demote = await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-demote' } });
    expect(demote).toMatchObject({ planDate: AS_OF, movedToDate: AS_OF, movedCount: 1, status: 'TODO', priority: 'P1' });
    const backlog = await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-backlog' } });
    expect(backlog).toMatchObject({ planDate: '2026-11-24', movedCount: 1, status: 'DEFERRED' });
    expect(backlog.deferReason).toBeTruthy();
    const abandon = await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-abandon' } });
    expect(abandon).toMatchObject({ planDate: '2026-11-24', movedCount: 2, status: 'CANCELLED' });
    expect(abandon.deferReason).toBeTruthy();

    const header = await prisma.planVersion.findUniqueOrThrow({ where: { id: first.data.versionId } });
    const after = JSON.parse(header.afterSnapshot ?? '{}') as { taskCount: number; newTaskCount: number; taskIds: string[]; carryover: { fingerprint: string } };
    expect(after.taskCount).toBe(after.taskIds.length);
    expect(after.newTaskCount).toBe(first.data.writtenTaskCount);
    expect(after.taskIds).toEqual(expect.arrayContaining(['carry-promote', 'carry-demote']));
    expect(after.carryover.fingerprint).toBe(value.carryover!.fingerprint);
    const createdTasks = await prisma.planTask.findMany({ where: { candidateId: { not: null } } });
    expect(createdTasks.length).toBeGreaterThan(0);
    expect(createdTasks.every((task) => task.resourceId === null)).toBe(true);

    const tasksAfter = await prisma.planTask.count();
    const versionsAfter = await prisma.planVersion.count();
    const second = await confirmPlanVersionAction(input);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('CONFLICT');
    expect(await prisma.planTask.count()).toBe(tasksAfter);
    expect(await prisma.planVersion.count()).toBe(versionsAfter);
    expect((await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-promote' } })).movedCount).toBe(1);
  });

  it('任务快照 20 分钟、有效会话 30 分钟时，预览与确认都只滚存剩余 30 分钟', async () => {
    await seedCarryover();
    await prisma.planTask.update({ where: { id: 'carry-promote' }, data: { plannedMinutes: 60 } });
    await prisma.studySession.create({
      data: {
        taskId: 'carry-promote',
        startedAt: new Date('2026-11-23T01:00:00Z'),
        endedAt: new Date('2026-11-23T01:30:00Z'),
        activeMinutes: 30,
        terminatedReason: 'COMPLETED',
        sessionDate: '2026-11-23',
        skill: 'LISTENING',
      },
    });
    const generated = await generatePlanPreviewAction({ ...INPUT, budgetOverrideMinutes: 200 });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const value = generated.data;
    expect(value.carryover?.decisions.find((decision) => decision.taskId === 'carry-promote')).toMatchObject({
      plannedMinutes: 60,
      actualMinutes: 30,
      remainingMinutes: 30,
    });

    const result = await confirmPlanVersionAction({
      ...INPUT,
      budgetOverrideMinutes: 200,
      snapshotId: value.snapshotId,
      previewToken: value.previewToken,
    });
    expect(result.ok).toBe(true);
    expect(await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-promote' } })).toMatchObject({
      planDate: AS_OF,
      plannedMinutes: 30,
      actualMinutes: 0,
      movedCount: 1,
    });
  });

  it('预览后计时状态变为 RUNNING → 确认 CONFLICT 且不写计划', async () => {
    await seedCarryover();
    const value = await preview();
    await prisma.planTask.update({
      where: { id: 'carry-promote' },
      data: { timerStatus: 'RUNNING', timerVersion: { increment: 1 } },
    });
    const versionsBefore = await prisma.planVersion.count();
    const snapshotsBefore = await prisma.planningSnapshot.count();

    const result = await confirmPlanVersionAction(confirmInput(value));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONFLICT');
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
    expect(await prisma.planningSnapshot.count()).toBe(snapshotsBefore);
    expect((await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-promote' } })).movedCount).toBe(0);
  });

  it('逾期任务在预览后变化 → token stale，确认零写', async () => {
    await seedCarryover();
    const value = await preview();
    await prisma.planTask.update({ where: { id: 'carry-promote' }, data: { priority: 'P1' } });
    const tasksBefore = await prisma.planTask.count();
    const versionsBefore = await prisma.planVersion.count();

    const result = await confirmPlanVersionAction(confirmInput(value));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONFLICT');
    expect(await prisma.planTask.count()).toBe(tasksBefore);
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
    expect((await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-promote' } })).movedCount).toBe(0);
  });

  it('预算覆盖在预览后变化 → token stale，确认零写', async () => {
    await seedCarryover();
    const generated = await generatePlanPreviewAction({ ...INPUT, budgetOverrideMinutes: 90 });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const versionsBefore = await prisma.planVersion.count();

    const result = await confirmPlanVersionAction({ ...confirmInput(generated.data), budgetOverrideMinutes: 80 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONFLICT');
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
    expect((await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-promote' } })).movedCount).toBe(0);
  });

  it('第二条新任务插入失败 → carryover、新任务与版本头全部回滚', async () => {
    await seedCarryover();
    const value = await preview();
    expect(value.days[0].tasks.length).toBeGreaterThan(1);
    const beforeRows = await prisma.planTask.findMany({ orderBy: { id: 'asc' } });
    const versionsBefore = await prisma.planVersion.count();
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_second_candidate BEFORE INSERT ON PlanTask
      WHEN NEW.candidateId IS NOT NULL
        AND (SELECT COUNT(*) FROM PlanTask WHERE candidateId IS NOT NULL) >= 1
      BEGIN SELECT RAISE(ABORT, 'forced second candidate failure'); END
    `);

    try {
      const result = await confirmPlanVersionAction(confirmInput(value));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INTERNAL');
      expect(await prisma.planTask.findMany({ orderBy: { id: 'asc' } })).toEqual(beforeRows);
      expect(await prisma.planVersion.count()).toBe(versionsBefore);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER fail_second_candidate');
    }
  });

  it('版本头唯一约束 P2002 → CONFLICT，事务内滚存与新任务全部回滚', async () => {
    await seedCarryover();
    const value = await preview();
    const beforeRows = await prisma.planTask.findMany({ orderBy: { id: 'asc' } });
    const versionsBefore = await prisma.planVersion.count();
    const transaction = prisma.$transaction.bind(prisma) as (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => Promise<unknown>;
    const transactionSpy = vi.spyOn(prisma, '$transaction').mockImplementation(((
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => transaction((tx) => callback(new Proxy(tx, {
      get(target, property, receiver) {
        if (property !== 'planVersion') return Reflect.get(target, property, receiver);
        return new Proxy(target.planVersion, {
          get(delegate, planProperty, planReceiver) {
            if (planProperty === 'create') return async () => { throw { code: 'P2002' }; };
            return Reflect.get(delegate, planProperty, planReceiver);
          },
        });
      },
    }) as Prisma.TransactionClient))) as typeof prisma.$transaction);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await confirmPlanVersionAction(confirmInput(value));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('CONFLICT');
      expect(await prisma.planTask.findMany({ orderBy: { id: 'asc' } })).toEqual(beforeRows);
      expect(await prisma.planVersion.count()).toBe(versionsBefore);
      expect(errorSpy).toHaveBeenCalledWith('计划确认唯一约束冲突', { code: 'P2002' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(value.previewToken);
    } finally {
      transactionSpy.mockRestore();
      prisma.$transaction = transaction as typeof prisma.$transaction;
      errorSpy.mockRestore();
    }
  });

  it('同一 token 并发确认只写一次，滚存次数只加一次', async () => {
    await seedCarryover();
    const value = await preview();
    const input = confirmInput(value);

    const results = await Promise.all([confirmPlanVersionAction(input), confirmPlanVersionAction(input)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const rejected = results.find((result) => !result.ok);
    if (rejected && !rejected.ok) expect(rejected.code).toBe('CONFLICT');
    expect(await prisma.planVersion.count({ where: { idempotencyKey: value.previewToken } })).toBe(1);
    expect((await prisma.planTask.findUniqueOrThrow({ where: { id: 'carry-promote' } })).movedCount).toBe(1);
  });
});
