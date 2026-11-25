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
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, path } = await createTestDb([
  'exerciseAttempt',
  'diagnosticAttempt',
  'generatedExercise',
  'diagnosticItem',
  'diagnosticBlueprint',
  'materialPackItem',
  'materialPack',
  'taskProposalItem',
  'taskProposal',
  'vocabularyAssignmentItem',
  'vocabularyAssignment',
  'reviewTask',
  'retestSchedule',
  'egiuReview',
  'egiuLesson',
  'listeningExercise',
  'speakingPrompt',
  'transcript',
  'audioAsset',
  'contentChunk',
  'parsedDocument',
  'materialExerciseSet',
  'mistake',
  'studyRecord',
  'studySessionDaySplit',
  'evidenceRecord',
  'studySession',
  'skillProfile',
  'goalMilestone',
  'learningGoal',
  'weeklyFocus',
  'learningCycle',
  'taskPriorityDecision',
  'taskCandidate',
  'skillGap',
  'planningSnapshot',
  'planTask',
  'planVersion',
  'dailyBudget',
  'weeklyDayAllocation',
  'weeklyTarget',
  'plannerSettings',
  'skillAllocationProfile',
  'stageAcceptanceItem',
  'stage',
  'learningMaterial',
  'resource',
]);

const { previewReplanAction, confirmReplanAction } = await import('@/lib/actions/planner');

const STAGE_ID = 'stage-replan';
const AS_OF_A = '2026-11-25';
const AS_OF_B = '2026-11-26';
const AS_OF_EMPTY = '2026-11-27';

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
});

afterAll(async () => {
  await prisma.$disconnect();
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(path)) unlinkSync(path);
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
    expect(resized?.after?.minutes).toBe(40);
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
});
