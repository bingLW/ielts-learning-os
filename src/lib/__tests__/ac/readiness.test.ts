/**
 * T09 AC-14 业务口径 + action 落库（验收 ⑦⑧⑨ + 评审/切换生命周期）。
 *
 * 业务口径（PRD §4.9 / AC-14）：
 * - ⑦ 阶段天数再长（daysCompleted=90 无法传入，F-2 已挡）也不补延迟复测的缺；
 * - ⑧ 单次 AI 分数 9.0 不参与判定（只出现在 notConsidered 反例区）；
 * - ⑨ notConsidered 必含「学习天数 / 完成率 / 单次 AI 分数」三项，只用于展示。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import { computeReadiness, type EvidenceDistribution, type ReadinessInput } from '@/lib/domain/readiness';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, path } = await createTestDb([
  'stageReadinessReview',
  'stageTransitionLog',
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

const { reviewReadinessAction, confirmStageTransitionAction } = await import('@/lib/actions/planner');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-readiness';

const SKILLS = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as const;

function dist(): EvidenceDistribution {
  return { baseline: 1, immediate: 1, delayed: 0, applied: 0, transfer: 0, independent: 2 };
}

function readyInput(): ReadinessInput {
  return {
    stageId: STAGE_ID,
    stageStart: '2026-01-01',
    asOfDate: AS_OF,
    officialGaps: [],
    officialUncertainties: [],
    evidenceBySkill: Object.fromEntries(SKILLS.map((skill) => [skill, dist()])) as Record<
      string,
      EvidenceDistribution
    >,
    retestOutcomes: [
      { retestType: 'DELAYED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r-delayed' },
      { retestType: 'APPLIED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r-applied' },
    ],
    distinctSources: SKILLS.map((skill) => ({ skill, sourceRefs: ['src-a', 'src-b'] })),
    readErrors: [],
  };
}

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S1_A0_A2',
      nameZh: 'readiness 测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'A0_A2',
    },
  });
  await prisma.stage.create({
    data: {
      id: 'stage-target',
      code: 'S2_A2_B1',
      nameZh: '目标阶段',
      estDaysMin: 30,
      status: 'NOT_STARTED',
      profileCode: 'A2_B1',
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

describe('T09 AC-14 业务口径（纯 computeReadiness）', () => {
  it('⑦ 阶段 90 天但延迟复测 0 条 DONE → NEED_MORE_EVIDENCE', () => {
    // daysCompleted 无法传入（F-2），这里刻意证明：即使其它维度全 PASS，
    // 只要延迟复测 0 条 DONE，结论就是 NEED_MORE_EVIDENCE —— 天数不补证据的缺。
    const input = readyInput();
    input.retestOutcomes = [
      { retestType: 'DELAYED', skill: 'LISTENING', status: 'PENDING', score: null, materialRef: 'r1' },
      { retestType: 'APPLIED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r2' },
    ];

    const result = computeReadiness(input);
    expect(result.outcome).toBe('NEED_MORE_EVIDENCE');
  });

  it('⑧ 单次 AI 分数 9.0 不影响结论（只出现在反例区）', () => {
    const result = computeReadiness(readyInput());
    // 「单次 AI 分数」只在 notConsidered 里出现，不在任何维度或结论里 —— 它进不了判定。
    expect(result.outcome).toBe('READY_FOR_REVIEW');
    expect(result.notConsidered.some((row) => row.label === '单次 AI 分数')).toBe(true);
    expect(JSON.stringify(result.dimensions)).not.toContain('9.0');
    expect(JSON.stringify(result.dimensions)).not.toContain('aiScore');
  });

  it('⑨ notConsidered 必含「学习天数 / 完成率 / 单次 AI 分数」三项且只用于展示', () => {
    const result = computeReadiness(readyInput());
    const labels = result.notConsidered.map((row) => row.label);
    expect(labels).toEqual(['学习天数', '完成率', '单次 AI 分数']);
    for (const row of result.notConsidered) {
      expect(row.value).toBe('不参与判定');
    }
  });
});

describe('T09 评审 / 切换 action 生命周期', () => {
  it('reviewReadinessAction 落库 StageReadinessReview，criteriaJson 含五维明细', async () => {
    const result = await reviewReadinessAction({ stageId: STAGE_ID, asOfDate: AS_OF });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const review = await prisma.stageReadinessReview.findUnique({
      where: { id: result.data.reviewId },
    });
    expect(review).not.toBeNull();
    expect(review!.userConfirmed).toBe(false);

    const criteria = JSON.parse(review!.criteriaJson) as Array<{ code: string; status: string }>;
    expect(Array.isArray(criteria)).toBe(true);
    expect(criteria).toHaveLength(5);
    expect(criteria.map((row) => row.code)).toEqual([
      'D1_EVIDENCE_COVERAGE',
      'D2_CROSS_SOURCE_CONSISTENCY',
      'D3_INDEPENDENT_COMPLETION',
      'D4_DELAYED_RETENTION',
      'D5_TRANSFER_EVIDENCE',
    ]);
    // 五维明细可回溯：每个维度都带状态与说明
    for (const row of criteria) {
      expect(['PASS', 'FAIL', 'INSUFFICIENT', 'READ_ERROR']).toContain(row.status);
    }
  });

  it('confirmStageTransitionAction 写 outcome=USER_APPROVED_TRANSITION + userConfirmed + StageTransitionLog', async () => {
    const review = await reviewReadinessAction({ stageId: STAGE_ID, asOfDate: AS_OF });
    expect(review.ok).toBe(true);
    if (!review.ok) return;

    const confirm = await confirmStageTransitionAction({
      reviewId: review.data.reviewId,
      toStageCode: 'S2_A2_B1',
      reason: '证据已满足，用户本人确认进入下一阶段',
      confirmedBy: '本人',
    });
    expect(confirm.ok).toBe(true);
    if (!confirm.ok) return;

    const updated = await prisma.stageReadinessReview.findUnique({
      where: { id: review.data.reviewId },
    });
    expect(updated?.outcome).toBe('USER_APPROVED_TRANSITION');
    expect(updated?.userConfirmed).toBe(true);
    expect(updated?.confirmedBy).toBe('本人');

    const log = await prisma.stageTransitionLog.findUnique({ where: { id: confirm.data.logId } });
    expect(log).not.toBeNull();
    expect(log!.toStageCode).toBe('S2_A2_B1');
    expect(log!.decidedBy).toBe('USER');
    expect(log!.evidenceSnapshot).toBe(updated!.criteriaJson);
  });

  it('重复确认同一 review → CONFLICT（幂等拦截）', async () => {
    const review = await reviewReadinessAction({ stageId: STAGE_ID, asOfDate: AS_OF });
    expect(review.ok).toBe(true);
    if (!review.ok) return;

    const first = await confirmStageTransitionAction({
      reviewId: review.data.reviewId,
      toStageCode: 'S2_A2_B1',
      reason: '证据已满足，用户本人确认进入下一阶段',
      confirmedBy: '本人',
    });
    expect(first.ok).toBe(true);

    const second = await confirmStageTransitionAction({
      reviewId: review.data.reviewId,
      toStageCode: 'S2_A2_B1',
      reason: '证据已满足，用户本人确认进入下一阶段',
      confirmedBy: '本人',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('CONFLICT');
  });
});
