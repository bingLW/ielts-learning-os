import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import type { CarryoverPreview } from '@/lib/domain/carryover';

const { prisma, cleanup } = await createTestDb();
const { getBuilderContext, getPlanExplanation } = await import('@/lib/queries/planner');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-carryover-query';
const DAY_VERSION = 'day-with-task-ids';
const WEEK_VERSION = 'week-with-task-ids';

const CARRYOVER: CarryoverPreview = {
  asOfDate: AS_OF,
  budgetMinutes: 60,
  fingerprint: 'a'.repeat(64),
  promotedCount: 1,
  demotedCount: 0,
  backlogCount: 0,
  abandonedCount: 0,
  overflowCount: 0,
  warnings: [],
  decisions: [{
    taskId: 'day-carried',
    module: 'READING',
    originalDate: '2026-11-23',
    previousPlanDate: '2026-11-23',
    previousPlanVersion: 1,
    previousPriority: 'P0',
    finalPriority: 'P0',
    plannedMinutes: 30,
    actualMinutes: 10,
    remainingMinutes: 20,
    movedCount: 1,
    splittable: true,
    minChunkMinutes: 5,
    overdueDays: 2,
    action: 'PROMOTE',
    reason: '到期复习逾期 2 天，优先补做',
    destination: `${AS_OF} / P0 / TODO`,
  }],
};

beforeAll(async () => {
  await prisma.stage.create({ data: { id: STAGE_ID, code: 'CARRYOVER_QUERY', nameZh: '滚存查询测试', estDaysMin: 30, status: 'ACTIVE' } });
  await prisma.planVersion.createMany({
    data: [
      {
        id: DAY_VERSION,
        planDate: AS_OF,
        version: 9,
        changeSource: 'GENERATE',
        layer: null,
        createdAt: new Date('2026-11-25T09:00:00Z'),
        afterSnapshot: JSON.stringify({ taskIds: ['day-new', 'day-carried'], taskCount: 2, carryover: CARRYOVER }),
      },
      {
        id: WEEK_VERSION,
        planDate: AS_OF,
        version: 8,
        changeSource: 'GENERATE',
        layer: 'WEEK',
        createdAt: new Date('2026-11-25T09:00:01Z'),
        afterSnapshot: JSON.stringify({ taskIds: ['week-new', 'week-carried'], taskCount: 2, carryover: null }),
      },
    ],
  });
  await prisma.planTask.createMany({
    data: [
      { id: 'day-new', stageId: STAGE_ID, planDate: AS_OF, module: 'GRAMMAR', skill: 'GRAMMAR', primarySkill: 'FOUNDATION', plannedMinutes: 40, priority: 'P0', planVersion: 1, sortOrder: 1 },
      { id: 'day-carried', stageId: STAGE_ID, planDate: AS_OF, module: 'READING', skill: 'READING', primarySkill: 'READING', plannedMinutes: 20, priority: 'P0', planVersion: 1, movedCount: 1, movedToDate: AS_OF, sortOrder: 0 },
      { id: 'week-new', stageId: STAGE_ID, planDate: AS_OF, module: 'GRAMMAR', skill: 'GRAMMAR', primarySkill: 'FOUNDATION', plannedMinutes: 40, priority: 'P0', planVersion: 1, sortOrder: 1 },
      { id: 'week-carried', stageId: STAGE_ID, planDate: '2026-11-26', module: 'READING', skill: 'READING', primarySkill: 'READING', plannedMinutes: 20, priority: 'P0', planVersion: 1, movedCount: 1, movedToDate: '2026-11-26', sortOrder: 0 },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('v2.7.1 阶段 C：版本任务快照查询', () => {
  it('DAY/WEEK 构建器按 afterSnapshot.taskIds 计数，不依赖逐条任务版本号', async () => {
    const value = await getBuilderContext(7, AS_OF);
    expect(value.layers.find((row) => row.layer === 'DAY')).toMatchObject({ versionId: DAY_VERSION, taskCount: 2 });
    expect(value.layers.find((row) => row.layer === 'WEEK')).toMatchObject({ versionId: WEEK_VERSION, taskCount: 2 });
  });

  it('解释页按 taskIds 读取本版新任务与滚入任务，并回放 carryover 摘要', async () => {
    const value = await getPlanExplanation(DAY_VERSION);
    expect(value).not.toBeNull();
    expect(value?.tasks.map((task) => task.taskId).sort()).toEqual(['day-carried', 'day-new']);
    expect(value?.carryover).toEqual(CARRYOVER);
    expect(value?.tradeoffs.totalPlannedMinutes).toBe(60);
  });

  it('周解释页读取头版本关联的两条任务，而非逐条旧版本号', async () => {
    const value = await getPlanExplanation(WEEK_VERSION);
    expect(value).not.toBeNull();
    expect(value?.tasks.map((task) => task.taskId).sort()).toEqual(['week-carried', 'week-new']);
    expect(value?.carryover).toBeNull();
  });
});
