/**
 * T07 AC-17 第一段 —— 验收 ⑫：`aiMode` 三态里只实现 `off` 路径（AI 桩阶段）。
 *
 * - ⑫ `allowAi=false` → `ok:true`、`aiMode='off'`、**所有** `byAi=false`、`aiNote` 非空。
 *
 * 为什么这算一条"验收"而不是摆设：T14 接真 AI 之前，服务层**不得** import `@/lib/ai/*`
 * （F-1 守门）。这条用例钉死「关掉 AI 时，规则结果原样返回、措辞来源恒为 TEMPLATE、
 * 没有任何任务被打上 AI 标记」，避免未来有人在 `buildPlan` 里偷接 AI 却没人抓。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

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

const { buildPlan } = await import('@/lib/services/planBuild');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-ai';

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: 'AI 桩测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'B1_B2',
    },
  });
  await prisma.skillAllocationProfile.create({
    data: {
      profileCode: 'B1_B2',
      listeningPct: 25,
      readingPct: 25,
      speakingPct: 25,
      writingPct: 25,
      effectiveFrom: '2026-01-01',
      isActive: true,
    },
  });
  await prisma.plannerSettings.create({
    data: { id: 1, defaultDailyMinutes: 60, minTaskMinutes: 5, isUserConfirmed: true },
  });
  await prisma.dailyBudget.create({
    data: { date: AS_OF, plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.learningGoal.create({
    data: { goalType: 'GENERAL_ENGLISH', name: '通用英语', status: 'ACTIVE', targetValue: 'B2' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(path)) unlinkSync(path);
});

describe('T07 aiMode=off 回退（AC-17 第一段）', () => {
  it('⑫ allowAi=false → ok + off + 全部 byAi=false + aiNote 非空', async () => {
    const result = await buildPlan({
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 1,
      stageId: STAGE_ID,
      allowAi: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.aiMode).toBe('off');
    expect(typeof result.data.aiNote).toBe('string');
    expect((result.data.aiNote as string).length).toBeGreaterThan(0);

    const tasks = result.data.days.flatMap((day) => day.tasks);
    // 关掉 AI 时规则路径必须产出任务（否则"全部 byAi=false"退化成空断言）
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.byAi).toBe(false);
      expect(task.aiCallLogId).toBeNull();
      expect(task.explanation.wordingSource).toBe('TEMPLATE');
    }
  });
});
