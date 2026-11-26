/**
 * T10 规划器查询层验收：12 个查询对同一份最小夹具的真实返回。
 *
 * 三条硬约束在这里被钉死（任何一条退化成「页面自行拼查询」都会红）：
 * - G-4：缺口查询必须按 `dimensionKind` 分层（辅助维度不得混进四技能分组）；
 * - I-2：候选 `estMinutes` 只出现在「预计」语境（排除原因、解释面板），
 *   `totalPlannedMinutes` 只来自 `PlanTask.plannedMinutes`；
 * - 只读：本文件的断言全部在 `createTestDb` 的临时库上，且查询层不写表
 *   （写行为由 `services/__tests__` 覆盖）。
 *
 * 夹具刻意只造一份快照、一份日版本、一份周版本：
 * 多版本混在同一个 `planDate` 上会让「今日计划分钟」变成跨版本求和，
 * 那是夹具失真而不是查询缺陷 —— 真实重排是同一批任务行升 `planVersion`。
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import { today, weekRange } from '@/lib/date';

const { prisma, cleanup } = await createTestDb([
  'goalMilestone',
  'learningGoal',
  'stageReadinessReview',
  'stageTransitionLog',
  'taskPriorityDecision',
  'taskCandidate',
  'skillGap',
  'evidenceRecord',
  'studySessionDaySplit',
  'studySession',
  'planTask',
  'planVersion',
  'planningSnapshot',
  'reviewTask',
  'egiuLesson',
  'stageAcceptanceItem',
  'weeklyDayAllocation',
  'weeklyTarget',
  'dailyBudget',
  'plannerSettings',
  'skillProfile',
  'stage',
]);

const {
  getPlannerDashboard,
  getGapSummary,
  getCandidateQueue,
  getExcludedReasons,
  getBuilderContext,
  getDraft,
  getPlanExplanation,
  getBudgetWeek,
  getWeeklyTargetSummary,
  getReplanContext,
  getReadinessView,
  getVersionHistory,
  getVersionDiff,
  getEvidenceDrawer,
} = await import('@/lib/queries/planner');

const AS_OF = '2026-11-25';
const PREV_WEEK = '2026-11-16';
const STAGE_ID = 'stage-q';
const SNAP = 'snap-main';
const SNAP_PENDING = 'snap-pending';
const DAY_VERSION = 'ver-day-1';
const WEEK_VERSION_V1 = 'ver-week-1';
const WEEK_VERSION_V2 = 'ver-week-2';

const { weekStart, weekEnd } = weekRange(AS_OF);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

function decisionJson(input: {
  priority: string;
  score: number;
  rationale: string;
  eligibility?: string;
  meta?: Record<string, unknown>;
}) {
  return JSON.stringify({
    factors: { urgency: 0.8, timeCost: 0.2 },
    ...(input.meta ? { meta: input.meta } : {}),
    score: input.score,
    priority: input.priority,
    rationale: input.rationale,
    eligibility: input.eligibility ?? 'ELIGIBLE',
  });
}

async function seed() {
  await prisma.learningGoal.create({
    data: {
      goalType: 'GENERAL_ENGLISH',
      name: '通用英语',
      status: 'ACTIVE',
      targetValue: 'B2',
    },
  });
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S1_A0_A2',
      nameZh: '训练区间 A0–A2',
      estDaysMin: 30,
      status: 'ACTIVE',
      startedAt: '2026-10-01',
      sortOrder: 1,
    },
  });
  await prisma.plannerSettings.create({
    data: { id: 1, defaultDailyMinutes: 60, isUserConfirmed: true, weeklyTargetMinutes: 600 },
  });

  // 预算：周一 120、周二休息、周三（AS_OF）120；其余日期走已确认的星期模板
  await prisma.dailyBudget.create({
    data: { date: '2026-11-23', plannedAvailableMinutes: 120, source: 'USER', budgetType: 'CUSTOM' },
  });
  await prisma.dailyBudget.create({
    data: { date: '2026-11-24', plannedAvailableMinutes: 0, isRestDay: true, source: 'USER', budgetType: 'REST_DAY' },
  });
  await prisma.dailyBudget.create({
    data: { date: AS_OF, plannedAvailableMinutes: 120, source: 'USER', budgetType: 'CUSTOM' },
  });

  await prisma.weeklyTarget.create({
    data: {
      id: 'wt-current',
      weekStart,
      targetMinutes: 600,
      status: 'ACTIVE',
      source: 'USER',
      allocations: {
        create: [
          { date: '2026-11-23', availableMinutes: 120, isRestDay: false },
          { date: '2026-11-24', availableMinutes: 0, isRestDay: true },
        ],
      },
    },
  });
  await prisma.weeklyTarget.create({
    data: { id: 'wt-prev', weekStart: PREV_WEEK, targetMinutes: 500, status: 'ADJUSTED', source: 'USER' },
  });

  await prisma.planningSnapshot.create({
    data: {
      id: SNAP,
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      inputHash: 'hash-main',
      ruleVersion: 'v2.7.0',
      budgetJson: JSON.stringify({ budgetMinutes: 120, source: 'USER' }),
      configJson: JSON.stringify({ minTaskMinutes: 5 }),
      validationJson: JSON.stringify({ ok: true, stale: [], missingBaseline: [], lowConfidence: [] }),
    },
  });
  // 未确认的生成预览：没有任何 PlanVersion.snapshotId 指向它
  await prisma.planningSnapshot.create({
    data: {
      id: SNAP_PENDING,
      purpose: 'GENERATE',
      asOfDate: '2026-11-20',
      inputHash: 'hash-pending',
      ruleVersion: 'v2.7.0',
      budgetJson: JSON.stringify({ budgetMinutes: 90 }),
      configJson: JSON.stringify({ minTaskMinutes: 5 }),
    },
  });

  await prisma.skillGap.createMany({
    data: [
      {
        id: 'gap-l',
        snapshotId: SNAP,
        dimensionKind: 'OFFICIAL',
        skill: 'LISTENING',
        subskill: 'gist_understanding',
        kind: 'GAP',
        confidence: 'HIGH',
        evidenceCount: 4,
        independentCount: 3,
        freshnessDays: 2,
        coverageRatio: 0.5,
        severity: 0.8,
        reason: '主旨题在无辅助条件下正确率 50%',
        evidenceIdsJson: JSON.stringify(['ev-1']),
      },
      {
        id: 'gap-r',
        snapshotId: SNAP,
        dimensionKind: 'OFFICIAL',
        skill: 'READING',
        subskill: 'detail_scanning',
        kind: 'UNCERTAINTY',
        confidence: 'LOW',
        evidenceCount: 1,
        severity: 0,
        reason: '细节定位只有 1 条证据，需要补测',
      },
      {
        id: 'gap-grammar',
        snapshotId: SNAP,
        dimensionKind: 'AUXILIARY',
        skill: 'GRAMMAR',
        subskill: 'tense',
        kind: 'GAP',
        confidence: 'MEDIUM',
        evidenceCount: 2,
        severity: 0.5,
        reason: '时态一致性反复出错',
      },
    ],
  });

  await prisma.taskCandidate.createMany({
    data: [
      {
        id: 'c1',
        snapshotId: SNAP,
        sourceKind: 'REVIEW',
        sourceRef: 'review:1',
        candidateKey: 'REVIEW:review:1|none:VOCAB_REVIEW',
        module: 'VOCAB_REVIEW',
        targetSkill: 'FOUNDATION',
        skillGapId: null,
        title: '复习到期词汇 20 个',
        estMinutes: 20,
      },
      {
        id: 'c2',
        snapshotId: SNAP,
        sourceKind: 'MATERIAL',
        sourceRef: 'material:1',
        candidateKey: 'MATERIAL:material:1|none:READING',
        module: 'READING',
        targetSkill: 'READING',
        skillGapId: 'gap-r',
        title: '细节定位精读 1 段',
        estMinutes: 40,
      },
      {
        id: 'c3',
        snapshotId: SNAP,
        sourceKind: 'QUESTION',
        sourceRef: 'question:1',
        candidateKey: 'QUESTION:question:1|none:WRITING',
        module: 'WRITING',
        targetSkill: 'WRITING',
        skillGapId: null,
        title: 'Task 2 全文写作',
        estMinutes: 30,
      },
      {
        id: 'c4',
        snapshotId: SNAP,
        sourceKind: 'PROBE',
        sourceRef: 'probe:1',
        candidateKey: 'PROBE:probe:1|none:SPEAKING',
        module: 'SPEAKING',
        targetSkill: 'SPEAKING',
        skillGapId: null,
        title: '口语补测 Part 2',
        estMinutes: 10,
      },
      {
        id: 'c5',
        snapshotId: SNAP,
        sourceKind: 'LAB',
        sourceRef: 'lab:1',
        candidateKey: 'LAB:lab:1|none:LISTENING',
        module: 'LISTENING',
        targetSkill: 'LISTENING',
        skillGapId: 'gap-l',
        title: 'AI 建议：泛听 15 分钟',
        estMinutes: 15,
        isAiSuggested: true,
      },
      {
        id: 'c6',
        snapshotId: SNAP,
        sourceKind: 'MATERIAL',
        sourceRef: 'material:2',
        candidateKey: 'MATERIAL:material:2|none:READING',
        module: 'READING',
        targetSkill: 'READING',
        skillGapId: null,
        title: '与精读重复的泛读材料',
        estMinutes: 25,
      },
    ],
  });

  await prisma.taskPriorityDecision.createMany({
    data: [
      {
        candidateId: 'c1',
        snapshotId: SNAP,
        weightsVersion: 'v1',
        factorsJson: decisionJson({ priority: 'P0', score: 0.9, rationale: '到期复习优先' }),
        score: 0.9,
        priority: 'P0',
        rationale: '到期复习优先',
        consequenceIfSkipped: '遗忘曲线覆盖断裂',
      },
      {
        candidateId: 'c2',
        snapshotId: SNAP,
        skillGapId: 'gap-r',
        weightsVersion: 'v1',
        factorsJson: decisionJson({
          priority: 'P1',
          score: 0.6,
          rationale: '有证据的弱项',
          meta: { skillGapKey: 'READING::detail_scanning|null', evidenceRefs: ['ev-1'] },
        }),
        score: 0.6,
        priority: 'P1',
        rationale: '有证据的弱项',
      },
      {
        candidateId: 'c3',
        snapshotId: SNAP,
        weightsVersion: 'v1',
        factorsJson: decisionJson({ priority: 'P2', score: 0.3, rationale: '产出训练', eligibility: 'OVER_BUDGET' }),
        score: 0.3,
        priority: 'P2',
        rationale: '产出训练',
        eligibility: 'OVER_BUDGET',
        blockedReason: '超出当日预算',
      },
      {
        candidateId: 'c4',
        snapshotId: SNAP,
        weightsVersion: 'v1',
        factorsJson: decisionJson({ priority: 'P1', score: 0.5, rationale: '补测', eligibility: 'BLOCKED_PREREQUISITE' }),
        score: 0.5,
        priority: 'P1',
        rationale: '补测',
        eligibility: 'BLOCKED_PREREQUISITE',
        blockedReason: '需先完成基线',
      },
      {
        candidateId: 'c5',
        snapshotId: SNAP,
        weightsVersion: 'v1',
        factorsJson: decisionJson({ priority: 'P2', score: 0.2, rationale: 'AI 建议', eligibility: 'REJECTED_NOT_IN_POOL' }),
        score: 0.2,
        priority: 'P2',
        rationale: 'AI 建议',
        eligibility: 'REJECTED_NOT_IN_POOL',
        blockedReason: 'AI 建议不在候选池',
      },
      {
        candidateId: 'c6',
        snapshotId: SNAP,
        weightsVersion: 'v1',
        factorsJson: decisionJson({ priority: 'P1', score: 0.4, rationale: '与精读重复', eligibility: 'DUPLICATE' }),
        score: 0.4,
        priority: 'P1',
        rationale: '与精读重复',
        eligibility: 'DUPLICATE',
        blockedReason: '与更优先候选重复',
      },
    ],
  });

  await prisma.planVersion.create({
    data: {
      id: DAY_VERSION,
      planDate: AS_OF,
      version: 1,
      changeSource: 'GENERATE',
      budgetMinutes: 120,
      snapshotId: SNAP,
      layer: null,
    },
  });
  // 上一周的周版本：与今日无关，专门用来验证 diff / history 的周期口径
  await prisma.planVersion.create({
    data: {
      id: WEEK_VERSION_V1,
      planDate: PREV_WEEK,
      version: 1,
      changeSource: 'GENERATE',
      budgetMinutes: 420,
      layer: 'WEEK',
      staleAt: new Date('2026-11-20T08:00:00Z'),
      staleReason: '预算变更',
    },
  });
  await prisma.planVersion.create({
    data: {
      id: WEEK_VERSION_V2,
      planDate: PREV_WEEK,
      version: 2,
      changeSource: 'REPLAN',
      budgetMinutes: 420,
      layer: 'WEEK',
      parentVersionId: WEEK_VERSION_V1,
    },
  });

  await prisma.planTask.createMany({
    data: [
      {
        id: 't1',
        stageId: STAGE_ID,
        planDate: AS_OF,
        module: 'READING',
        skill: 'READING',
        primarySkill: 'READING',
        plannedMinutes: 60,
        status: 'TODO',
        priority: 'P0',
        sortOrder: 0,
        planVersion: 1,
        candidateId: 'c2',
        decisionJson: decisionJson({ priority: 'P0', score: 0.91, rationale: '到期复习优先（写入时快照）' }),
      },
      {
        id: 't2',
        stageId: STAGE_ID,
        planDate: AS_OF,
        module: 'VOCAB_REVIEW',
        skill: 'VOCAB',
        primarySkill: 'FOUNDATION',
        plannedMinutes: 30,
        actualMinutes: 25,
        status: 'DONE',
        priority: 'P1',
        sortOrder: 1,
        planVersion: 1,
      },
      {
        id: 't3',
        stageId: STAGE_ID,
        planDate: AS_OF,
        module: 'WRITING',
        skill: 'WRITING',
        primarySkill: 'WRITING',
        plannedMinutes: 45,
        status: 'CANCELLED',
        priority: 'P2',
        sortOrder: 2,
        planVersion: 1,
      },
      // 上一周：v1 与 v2 各两条，验证 diff 只看计划分钟
      {
        id: 'w1',
        stageId: STAGE_ID,
        planDate: PREV_WEEK,
        module: 'READING',
        skill: 'READING',
        primarySkill: 'READING',
        plannedMinutes: 60,
        status: 'TODO',
        priority: 'P1',
        planVersion: 1,
      },
      {
        id: 'w2',
        stageId: STAGE_ID,
        planDate: '2026-11-17',
        module: 'WRITING',
        skill: 'WRITING',
        primarySkill: 'WRITING',
        plannedMinutes: 45,
        status: 'TODO',
        priority: 'P1',
        planVersion: 1,
      },
      {
        id: 'w3',
        stageId: STAGE_ID,
        planDate: PREV_WEEK,
        module: 'READING',
        skill: 'READING',
        primarySkill: 'READING',
        plannedMinutes: 40,
        status: 'TODO',
        priority: 'P1',
        planVersion: 2,
      },
      {
        id: 'w4',
        stageId: STAGE_ID,
        planDate: '2026-11-17',
        module: 'WRITING',
        skill: 'WRITING',
        primarySkill: 'WRITING',
        plannedMinutes: 55,
        status: 'TODO',
        priority: 'P1',
        planVersion: 2,
      },
    ],
  });

  await prisma.studySession.create({
    data: {
      id: 's1',
      taskId: 't2',
      startedAt: new Date('2026-11-25T01:00:00Z'),
      endedAt: new Date('2026-11-25T01:25:00Z'),
      activeMinutes: 25,
      terminatedReason: 'COMPLETED',
      sessionDate: AS_OF,
      skill: 'FOUNDATION',
      daySplits: {
        create: [
          { date: AS_OF, minutes: 25 },
          { date: '2026-11-24', minutes: 10 },
        ],
      },
    },
  });

  await prisma.evidenceRecord.create({
    data: { id: 'ev-1', skill: 'LISTENING', evidenceType: 'BASELINE', level: 'QUICK' },
  });
  await prisma.skillProfile.create({ data: { skill: 'LISTENING', confidence: 'MEDIUM' } });

  await prisma.stageReadinessReview.create({
    data: {
      snapshotId: SNAP,
      stageId: STAGE_ID,
      outcome: 'READY_FOR_REVIEW',
      criteriaJson: JSON.stringify([
        { code: 'D1_EVIDENCE_COVERAGE', label: '证据覆盖', current: '4/4', target: '≥3 源', passed: true },
        { code: 'D4_DELAYED_RETENTION', label: '延迟保持', current: '0', target: '≥1', passed: false },
      ]),
      evidenceRefsJson: JSON.stringify(['ev-1']),
      unmetJson: JSON.stringify(['延迟复测尚未完成']),
    },
  });
}

await seed();

describe('查询 1：getPlannerDashboard', () => {
  it('状态带只统计计划分钟（CANCELLED 不计），实际净分钟只来自 DaySplit', async () => {
    const dto = await getPlannerDashboard(AS_OF);
    expect(dto.diagnosed).toBe(true);
    expect(dto.latestSnapshotId).toBe(SNAP);
    expect(dto.statusBand.budgetMinutes).toBe(120);
    expect(dto.statusBand.plannedMinutes).toBe(90); // 60 + 30，CANCELLED 45 不计
    expect(dto.statusBand.actualNetMinutes).toBe(25);
    expect(dto.statusBand.taskCount).toBe(3);
    expect(dto.statusBand.doneCount).toBe(1);
    // 规则生成：AI 未参与（T14 之前恒为 off）
    expect(dto.statusBand.aiMode).toBe('off');
    expect(dto.statusBand.aiNote).toContain('AI 未参与');
  });

  it('今日决策：优先级计数与 P0 置顶', async () => {
    const dto = await getPlannerDashboard(AS_OF);
    expect(dto.todayDecision.p0Count).toBe(1);
    expect(dto.todayDecision.p1Count).toBe(1);
    expect(dto.todayDecision.doneMinutes).toBe(25);
    expect(dto.todayDecision.top[0].taskId).toBe('t1');
  });

  it('缺口只取 OFFICIAL（G-4）：辅助维度 Grammar 不进仪表盘', async () => {
    const dto = await getPlannerDashboard(AS_OF);
    expect(dto.gapTop3.map((row) => row.skill)).toEqual(['LISTENING']);
    expect(dto.uncertaintyTop3.map((row) => row.skill)).toEqual(['READING']);
    const allSkills = [...dto.gapTop3, ...dto.uncertaintyTop3].map((row) => row.skill);
    expect(allSkills).not.toContain('GRAMMAR');
  });

  it('待确认 = 有快照但没有版本指向它；已确认的不提示', async () => {
    const dto = await getPlannerDashboard(AS_OF);
    expect(dto.pendingConfirmations.map((row) => row.snapshotId)).toEqual([SNAP_PENDING]);
    const codes = dto.banners.map((banner) => banner.code);
    expect(codes).toContain('PENDING_CONFIRMATION');
    expect(codes).toContain('STALE_VERSIONS');
    expect(codes).not.toContain('NO_BASELINE');
    expect(codes).not.toContain('BUDGET_IS_SUGGESTION');
  });

  it('周口径：起止日来自 ISO 周，容量按每日有效预算求和', async () => {
    const dto = await getPlannerDashboard(AS_OF);
    expect(dto.weeklyGap.weekStart).toBe(weekStart);
    expect(dto.weeklyGap.weekEnd).toBe(weekEnd);
    expect(dto.weeklyGap.targetMinutes).toBe(600);
    // 120 + 0 + 120 + 模板 60×3（周日模板为 0）
    expect(dto.weeklyGap.capacityMinutes).toBe(420);
    expect(dto.weeklyGap.netMinutes).toBe(35);
  });
});

describe('查询 2：getGapSummary', () => {
  it('四技能各一组 + 辅助维度单列，不合并成平铺列表', async () => {
    const dto = await getGapSummary(SNAP);
    expect(dto).not.toBeNull();
    if (!dto) return;
    expect(Object.keys(dto.official)).toEqual(['LISTENING', 'READING', 'SPEAKING', 'WRITING']);
    expect(dto.official.LISTENING.map((row) => row.id)).toEqual(['gap-l']);
    expect(dto.official.READING.map((row) => row.id)).toEqual(['gap-r']);
    expect(dto.official.SPEAKING).toEqual([]);
    expect(dto.auxiliary.map((row) => row.id)).toEqual(['gap-grammar']);
    expect(dto.gapCount).toBe(2);
    expect(dto.uncertaintyCount).toBe(1);
    expect(dto.candidateCount).toBe(6);
  });

  it('不存在的快照返回 null（页面据此显示空态）', async () => {
    await expect(getGapSummary('snap-missing')).resolves.toBeNull();
  });
});

describe('查询 3：getCandidateQueue', () => {
  it('默认返回全部候选：资格 → 优先级 → 分数排序', async () => {
    const dto = await getCandidateQueue(SNAP);
    expect(dto.total).toBe(6);
    expect(dto.rows.slice(0, 2).map((row) => row.id)).toEqual(['c1', 'c2']);
    const firstIneligible = dto.rows.findIndex((row) => row.decision?.eligibility !== 'ELIGIBLE');
    const lastEligible = dto.rows.map((row) => row.decision?.eligibility).lastIndexOf('ELIGIBLE');
    expect(firstIneligible).toBeGreaterThan(lastEligible);
    expect(dto.aiNote).toBe('AI 未参与本次排序');
  });

  it('过滤条件逐一生效（来源 / 技能 / 分钟区间 / 优先级）', async () => {
    await expect(getCandidateQueue(SNAP, { sourceKind: 'REVIEW' }).then((dto) => dto.rows.map((row) => row.id))).resolves.toEqual(['c1']);
    await expect(getCandidateQueue(SNAP, { skill: 'READING' }).then((dto) => dto.rows.map((row) => row.id))).resolves.toEqual(['c2', 'c6']);
    await expect(
      getCandidateQueue(SNAP, { minMinutes: 20, maxMinutes: 40 }).then((dto) => dto.rows.map((row) => row.estMinutes).sort()),
    ).resolves.toEqual([20, 25, 30, 40]);
    await expect(getCandidateQueue(SNAP, { priority: 'P0' }).then((dto) => dto.rows.map((row) => row.id))).resolves.toEqual(['c1']);
  });

  it('DTO 暴露决策原文：rationale / score / 权重版本', async () => {
    const dto = await getCandidateQueue(SNAP, { skill: 'READING' });
    const c2 = dto.rows.find((row) => row.id === 'c2');
    expect(c2?.decision?.score).toBe(0.6);
    expect(c2?.decision?.weightsVersion).toBe('v1');
    expect(c2?.decision?.rationale).toBe('有证据的弱项');
    expect(c2?.decision?.skillGapKey).toBe('READING::detail_scanning|null');
    expect(c2?.decision?.evidenceRefs).toEqual(['ev-1']);
    expect(c2?.sourceLabel).toBe('材料任务');
  });
});

describe('查询 4：getExcludedReasons', () => {
  it('四类分组固定顺序，空组也返回', async () => {
    const dto = await getExcludedReasons(SNAP);
    expect(dto.groups.map((group) => group.code)).toEqual([
      'PREREQUISITE',
      'BUDGET',
      'DUPLICATE',
      'AI_REJECTED',
    ]);
    expect(dto.total).toBe(4);
  });

  it('eligibility → 分组的映射逐条正确', async () => {
    const dto = await getExcludedReasons(SNAP);
    const byCode = new Map(dto.groups.map((group) => [group.code, group.items.map((item) => item.candidateKey)]));
    expect(byCode.get('PREREQUISITE')).toEqual(['PROBE:probe:1|none:SPEAKING']);
    expect(byCode.get('BUDGET')).toEqual(['QUESTION:question:1|none:WRITING']);
    expect(byCode.get('DUPLICATE')).toEqual(['MATERIAL:material:2|none:READING']);
    expect(byCode.get('AI_REJECTED')).toEqual(['LAB:lab:1|none:LISTENING']);
    const budget = dto.groups.find((group) => group.code === 'BUDGET');
    expect(budget?.items[0].reason).toBe('超出当日预算');
  });
});

describe('查询 5：getBuilderContext', () => {
  it('horizonDays=7 → WEEK，四层各自最近一版；未生成的层返回空位而不是 null 崩溃', async () => {
    const dto = await getBuilderContext(7, AS_OF);
    expect(dto.layer).toBe('WEEK');
    expect(dto.layers.map((row) => row.layer)).toEqual(['DAY', 'WEEK', 'MONTH', 'CYCLE']);
    const day = dto.layers.find((row) => row.layer === 'DAY');
    const week = dto.layers.find((row) => row.layer === 'WEEK');
    const month = dto.layers.find((row) => row.layer === 'MONTH');
    expect(day?.versionId).toBe(DAY_VERSION);
    expect(day?.taskCount).toBe(3);
    expect(week?.versionId).toBe(WEEK_VERSION_V2);
    expect(week?.taskCount).toBe(2);
    expect(week?.staleAt).toBeNull();
    expect(month?.versionId).toBe('');
    expect(month?.structure).toBeNull();
    expect(dto.diagnosisReady).toBe(true);
    expect(dto.disabledLayers).toEqual([]);
    expect(dto.snapshot?.officialGapCount).toBe(2);
    expect(dto.snapshot?.auxiliaryGapCount).toBe(1);
  });
});

describe('查询 6：getDraft', () => {
  it('草稿锚点 = PlanningSnapshot，JSON 原样解析', async () => {
    const dto = await getDraft(SNAP);
    expect(dto).not.toBeNull();
    if (!dto) return;
    expect(dto.draftId).toBe(SNAP);
    expect(dto.ruleVersion).toBe('v2.7.0');
    expect(dto.budgetJson).toEqual({ budgetMinutes: 120, source: 'USER' });
    expect(dto.validationJson).toEqual({ ok: true, stale: [], missingBaseline: [], lowConfidence: [] });
    expect(dto.officialGapCount).toBe(2);
    expect(dto.auxiliaryGapCount).toBe(1);
    expect(dto.candidateCount).toBe(6);
  });
});

describe('查询 7：getPlanExplanation', () => {
  it('解释读写入时快照；计划分钟只来自 PlanTask', async () => {
    const dto = await getPlanExplanation(DAY_VERSION);
    expect(dto).not.toBeNull();
    if (!dto) return;
    expect(dto.tasks).toHaveLength(3);
    expect(dto.tradeoffs.totalPlannedMinutes).toBe(90);
    expect(dto.goalRef).toBe('B2');
    const t1 = dto.tasks.find((task) => task.taskId === 't1');
    expect(t1?.explanation.reason).toBe('到期复习优先（写入时快照）');
    expect(t1?.explanation.score).toBe(0.91);
  });

  it('被预算挤掉的候选给「预计分钟」而非计划分钟', async () => {
    const dto = await getPlanExplanation(DAY_VERSION);
    expect(dto?.tradeoffs.excludedByBudget).toHaveLength(1);
    expect(dto?.tradeoffs.excludedByBudget[0].estMinutes).toBe(30);
    expect(dto?.tradeoffs.excludedByBudget[0].title).toBe('Task 2 全文写作');
  });

  it('AI 拒绝的两类要么都有理由，要么如实显示 eligibility', async () => {
    const dto = await getPlanExplanation(DAY_VERSION);
    expect(dto?.rejectedAiSuggestions).toHaveLength(1);
    expect(dto?.rejectedAiSuggestions[0].reason).toBe('AI 建议不在候选池');
  });

  it('缺口引用来自决策 factorsJson.meta（不是运行时推断）', async () => {
    const dto = await getPlanExplanation(DAY_VERSION);
    const t1 = dto?.tasks.find((task) => task.taskId === 't1');
    expect(t1?.explanation.gapRef).toEqual({
      skillGapKey: 'READING::detail_scanning|null',
      evidenceRefs: ['ev-1'],
    });
    expect(t1?.explanation.estMinutes).toBe(40);
    expect(t1?.explanation.origin).toBe('RULE');
    expect(t1?.explanation.wordingSource).toBe('TEMPLATE');
  });
});

describe('查询 8：getBudgetWeek / getWeeklyTargetSummary', () => {
  it('周预算按每日有效预算解析，计划分钟排除 CANCELLED', async () => {
    const dto = await getBudgetWeek(weekStart);
    expect(dto.days).toHaveLength(7);
    expect(dto.days[0]).toMatchObject({ date: '2026-11-23', budgetMinutes: 120, isRestDay: false });
    expect(dto.days[1]).toMatchObject({ date: '2026-11-24', budgetMinutes: 0, isRestDay: true });
    expect(dto.days[2]).toMatchObject({ date: AS_OF, budgetMinutes: 120, plannedMinutes: 90, netMinutes: 25 });
    expect(dto.totals.budgetMinutes).toBe(420);
    expect(dto.isFirstInstallSuggestion).toBe(false);
  });

  it('周目标摘要含最近四周与实际净分钟', async () => {
    const dto = await getWeeklyTargetSummary(weekStart);
    expect(dto.targetMinutes).toBe(600);
    expect(dto.actualNetMinutes).toBe(35);
    expect(dto.allocations).toEqual([
      { date: '2026-11-23', availableMinutes: 120, isRestDay: false },
      { date: '2026-11-24', availableMinutes: 0, isRestDay: true },
    ]);
    expect(dto.recent).toEqual([{ weekStart: PREV_WEEK, targetMinutes: 500, status: 'ADJUSTED' }]);
  });
});

describe('查询 9：getReplanContext', () => {
  it('已产生实际分钟 / 已完成的受保护；其它可重排', async () => {
    const dto = await getReplanContext(AS_OF);
    expect(dto.hasTasks).toBe(true);
    expect(dto.tasks).toHaveLength(3);
    expect(dto.protectedTaskIds).toEqual(['t2']);
    expect(dto.budget.minutes).toBe(120);
    expect(dto.actualNetMinutes).toBe(25);
    expect(dto.versionCount).toBe(1);
    expect(dto.lastVersion).toBe(1);
    const t1 = dto.tasks.find((task) => task.taskId === 't1');
    expect(t1?.protected).toBe(false);
    expect(t1?.priority).toBe('P0');
  });
});

describe('查询 10：getReadinessView', () => {
  it('只回放最近评审快照 + 门禁，不重算结论', async () => {
    const dto = await getReadinessView(STAGE_ID);
    expect(dto).not.toBeNull();
    if (!dto) return;
    expect(dto.stage?.code).toBe('S1_A0_A2');
    expect(dto.latestReview?.outcome).toBe('READY_FOR_REVIEW');
    expect(dto.latestReview?.criteria).toHaveLength(2);
    expect(dto.latestReview?.unmet).toEqual(['延迟复测尚未完成']);
    expect(dto.latestReview?.userConfirmed).toBe(false);
    expect(dto.gate).not.toBeNull();
    expect(dto.evidenceCount).toBe(1);
    expect(dto.notConsidered.map((row) => row.label)).toEqual(['学习天数', '完成率', '单次 AI 分数']);
    for (const row of dto.notConsidered) {
      expect(row.note).toBe('不参与判定');
      expect(row.value.length).toBeGreaterThan(0);
    }
  });

  it('不存在的阶段返回 null', async () => {
    await expect(getReadinessView('stage-missing')).resolves.toBeNull();
  });
});

describe('查询 11：getVersionHistory', () => {
  it('layer=DAY 读 layer IS NULL 的历史行（v2.7 之前的日计划）', async () => {
    const rows = await getVersionHistory({ layer: 'DAY' });
    expect(rows.map((row) => row.id)).toEqual([DAY_VERSION]);
    expect(rows[0].layer).toBe('DAY');
    expect(rows[0].aiInvolved).toBe(false);
  });

  it('layer=WEEK 按 planDate/version 倒序，失效标记透传', async () => {
    const rows = await getVersionHistory({ layer: 'WEEK' });
    expect(rows.map((row) => row.id)).toEqual([WEEK_VERSION_V2, WEEK_VERSION_V1]);
    expect(rows[1].staleReason).toBe('预算变更');
    expect(rows[1].staleAt).not.toBeNull();
    expect(rows[0].parentVersionId).toBe(WEEK_VERSION_V1);
  });

  it('日期区间过滤', async () => {
    const rows = await getVersionHistory({ from: PREV_WEEK, to: '2026-11-22' });
    expect(rows.map((row) => row.id).sort()).toEqual([WEEK_VERSION_V1, WEEK_VERSION_V2]);
  });
});

describe('查询 12：getVersionDiff', () => {
  it('按模块对比计划分钟（不含实际），delta 有符号', async () => {
    const dto = await getVersionDiff(WEEK_VERSION_V1, WEEK_VERSION_V2);
    expect(dto).not.toBeNull();
    if (!dto) return;
    expect(dto.before.id).toBe(WEEK_VERSION_V1);
    expect(dto.after.id).toBe(WEEK_VERSION_V2);
    const byModule = new Map(dto.rows.map((row) => [row.module, row]));
    expect(byModule.get('READING')).toMatchObject({ beforeMinutes: 60, afterMinutes: 40, deltaMinutes: -20 });
    expect(byModule.get('WRITING')).toMatchObject({ beforeMinutes: 45, afterMinutes: 55, deltaMinutes: 10, afterCount: 1 });
  });

  it('版本不存在时返回 null', async () => {
    await expect(getVersionDiff(WEEK_VERSION_V1, 'ver-missing')).resolves.toBeNull();
  });

  it('证据抽屉查询已从规划器入口导出（页面只 import 一处）', () => {
    expect(typeof getEvidenceDrawer).toBe('function');
  });
});

describe('夹具自检', () => {
  it('测试不依赖本机 dev.db 的具体行（只依赖 seed 函数）', async () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const stageCount = await prisma.stage.count();
    expect(stageCount).toBe(1);
  });
});