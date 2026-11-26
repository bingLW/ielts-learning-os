/**
 * v2.7 规划器的只读查询层（T10）。
 *
 * 10 个页面的数据都从这里取（`41 §7`）。三条硬约束：
 *
 * 1. **只读**：本文件不写任何表，也不调 `buildPlanningSnapshot()`（那会落快照）。
 *    预览/确认仍在 `actions/planner.ts`。
 * 2. **候选分钟只计数、不求和**（I-2）：`TaskCandidate.estMinutes` 是「预计」，
 *    不是计划分钟。任何「今日候选总分钟」都必须用计数表达 —— 求了就会与
 *    `PlanTask.plannedMinutes` 形成两套口径。
 * 3. **缺口查询必须显式带 `dimensionKind`**（G-4）：官方四项与辅助维度共用
 *    `SkillGap` 一张表，漏了过滤就会让 Grammar 缺口混进四技能分母。
 *
 * 时间口径：计划分钟 = Σ`PlanTask.plannedMinutes`（排除 CANCELLED/DEFERRED）；
 * 实际净分钟 = Σ`StudySessionDaySplit.minutes`。两者不互相推算。
 */

import {
  MODULE_META,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL_ZH,
  TASK_STATUSES_EXCLUDED_FROM_RATE,
} from '@/lib/constants';
import { addDays, listDateRange, today, weekRange } from '@/lib/date';
import { completionRate } from '@/lib/domain/completion';
import type { CandidateSourceKind } from '@/lib/domain/taskCandidate';
import { resolveSourceBadge } from '@/lib/domain/sourceBadge';
import { parseJson, parseStringArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { layerOf, type PlanLayer, type PlanLayerStructure } from '@/lib/services/planBuild';
import type {
  GateResult,
  ModuleId,
  SkillId,
  StageCode,
  TaskPriority,
  TaskSourceKind,
  TaskStatus,
  TimerStatus,
} from '@/lib/types';
import type { CandidateFilterInput } from '@/lib/schema/planner';
import { getBudgetRange, getEffectiveBudget, getWeeklyTarget, listRecentWeeklyTargets } from './budget';
import { getActiveStage, getStageGate } from './stages';

export { getEvidenceDetail as getEvidenceDrawer } from './evidence';

/** 候选来源的中文标签（与 `CANDIDATE_SOURCE_KINDS` 键集一致，仅用于本层 DTO）。 */
const CANDIDATE_SOURCE_LABEL: Record<CandidateSourceKind, string> = {
  REVIEW: '复习',
  RETEST: '到期复测',
  PROBE: '补测（证据不足）',
  VOCAB: '词汇',
  MATERIAL: '材料任务',
  QUESTION: '题目',
  LAB: '实验任务',
  EGIU: 'EGIU 课程',
};

const OFFICIAL_SKILLS = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as const;

/** 预览快照的「待确认」窗口（天）：更早的预览视为已过期，不再提示。 */
const PENDING_WINDOW_DAYS = 7;

function isScheduledStatus(status: string): boolean {
  return !TASK_STATUSES_EXCLUDED_FROM_RATE.includes(status as TaskStatus);
}

function priorityOf(raw: string | null | undefined): TaskPriority {
  return TASK_PRIORITIES.includes(raw as TaskPriority) ? (raw as TaskPriority) : 'P1';
}

function moduleLabelOf(module: string): string {
  return MODULE_META[module as ModuleId]?.labelZh ?? module;
}

// ───────────────────────── 共用行形状 ─────────────────────────

/** 一条缺口（官方或辅助；由调用方决定放进哪一组）。 */
export interface GapRowDto {
  id: string;
  dimensionKind: 'OFFICIAL' | 'AUXILIARY';
  skill: string;
  subskill: string;
  kind: string;
  confidence: string;
  evidenceCount: number;
  independentCount: number;
  freshnessDays: number | null;
  coverageRatio: number | null;
  severity: number;
  reason: string;
  evidenceRefs: string[];
  missingEvidence: string[];
  status: string;
}

function toGapRow(row: {
  id: string;
  dimensionKind: string;
  skill: string;
  subskill: string;
  kind: string;
  confidence: string;
  evidenceCount: number;
  independentCount: number;
  freshnessDays: number | null;
  coverageRatio: number | null;
  severity: number;
  reason: string;
  evidenceIdsJson: string | null;
  missingEvidenceJson: string | null;
  status: string;
}): GapRowDto {
  return {
    id: row.id,
    dimensionKind: row.dimensionKind === 'AUXILIARY' ? 'AUXILIARY' : 'OFFICIAL',
    skill: row.skill,
    subskill: row.subskill,
    kind: row.kind,
    confidence: row.confidence,
    evidenceCount: row.evidenceCount,
    independentCount: row.independentCount,
    freshnessDays: row.freshnessDays,
    coverageRatio: row.coverageRatio,
    severity: row.severity,
    reason: row.reason,
    evidenceRefs: parseStringArray(row.evidenceIdsJson),
    missingEvidence: parseStringArray(row.missingEvidenceJson),
    status: row.status,
  };
}

/** 一条候选 + 它的优先级决策（解释面板的原料）。 */
export interface CandidateRowDto {
  id: string;
  candidateKey: string;
  snapshotId: string;
  sourceKind: string;
  sourceLabel: string;
  sourceRef: string | null;
  module: string;
  moduleLabel: string;
  targetSkill: string;
  skillGapId: string | null;
  title: string;
  estMinutes: number;
  minMinutes: number;
  maxBlockMinutes: number | null;
  prerequisites: string[];
  validationStatus: string;
  difficultyScore: number | null;
  isAiSuggested: boolean;
  status: string;
  decision: {
    priority: TaskPriority;
    priorityLabel: string;
    score: number;
    weightsVersion: string;
    factors: Record<string, number> | null;
    rationale: string;
    consequenceIfSkipped: string | null;
    eligibility: string;
    blockedReason: string | null;
    skillGapKey: string | null;
    evidenceRefs: string[];
    noObservation: boolean | null;
  } | null;
}

interface DecisionMetaShape {
  skillGapKey?: string | null;
  evidenceRefs?: string[];
  noObservation?: boolean;
  estMinutesSource?: string;
  derivedFrom?: string;
}

function toCandidateRow(row: {
  id: string;
  candidateKey: string;
  snapshotId: string;
  sourceKind: string;
  sourceRef: string | null;
  module: string;
  targetSkill: string;
  skillGapId: string | null;
  title: string;
  estMinutes: number;
  minMinutes: number;
  maxBlockMinutes: number | null;
  prerequisitesJson: string | null;
  validationStatus: string;
  difficultyScore: number | null;
  isAiSuggested: boolean;
  status: string;
  decision: {
    priority: string;
    score: number;
    weightsVersion: string;
    factorsJson: string;
    rationale: string;
    consequenceIfSkipped: string | null;
    eligibility: string;
    blockedReason: string | null;
  } | null;
}): CandidateRowDto {
  const decision = row.decision;
  const parsed = decision
    ? parseJson<{ factors?: Record<string, number>; meta?: DecisionMetaShape }>(decision.factorsJson, {})
    : {};
  return {
    id: row.id,
    candidateKey: row.candidateKey,
    snapshotId: row.snapshotId,
    sourceKind: row.sourceKind,
    sourceLabel: CANDIDATE_SOURCE_LABEL[row.sourceKind as CandidateSourceKind] ?? row.sourceKind,
    sourceRef: row.sourceRef,
    module: row.module,
    moduleLabel: moduleLabelOf(row.module),
    targetSkill: row.targetSkill,
    skillGapId: row.skillGapId,
    title: row.title,
    estMinutes: row.estMinutes,
    minMinutes: row.minMinutes,
    maxBlockMinutes: row.maxBlockMinutes,
    prerequisites: parseStringArray(row.prerequisitesJson),
    validationStatus: row.validationStatus,
    difficultyScore: row.difficultyScore,
    isAiSuggested: row.isAiSuggested,
    status: row.status,
    decision: decision
      ? {
          priority: priorityOf(decision.priority),
          priorityLabel: TASK_PRIORITY_LABEL_ZH[decision.priority] ?? decision.priority,
          score: decision.score,
          weightsVersion: decision.weightsVersion,
          factors: parsed.factors ?? null,
          rationale: decision.rationale,
          consequenceIfSkipped: decision.consequenceIfSkipped,
          eligibility: decision.eligibility,
          blockedReason: decision.blockedReason,
          skillGapKey: parsed.meta?.skillGapKey ?? null,
          evidenceRefs: parsed.meta?.evidenceRefs ?? [],
          noObservation: parsed.meta?.noObservation ?? null,
        }
      : null,
  };
}

// ───────────────────────── 1. /planner 仪表盘 ─────────────────────────

export interface PlannerBanner {
  level: 'info' | 'warning';
  code: string;
  text: string;
}

export interface PlannerDashboardDto {
  asOfDate: string;
  diagnosed: boolean;
  latestSnapshotId: string | null;
  statusBand: {
    stageId: string | null;
    stageCode: StageCode | null;
    stageName: string | null;
    budgetMinutes: number;
    isRestDay: boolean;
    isSuggestion: boolean;
    plannedMinutes: number;
    actualNetMinutes: number;
    taskCount: number;
    doneCount: number;
    aiMode: 'off' | 'on' | 'failed';
    aiNote: string;
  };
  todayDecision: {
    plannedMinutes: number;
    doneMinutes: number;
    taskCount: number;
    p0Count: number;
    p1Count: number;
    top: { taskId: string; moduleLabel: string; priority: TaskPriority; plannedMinutes: number; status: TaskStatus }[];
  };
  /** 已生成快照（有预览）但还没有任何 `PlanVersion` 指向它的生成请求。 */
  pendingConfirmations: { snapshotId: string; purpose: string; asOfDate: string; createdAt: string }[];
  weeklyGap: {
    weekStart: string;
    weekEnd: string;
    targetMinutes: number | null;
    capacityMinutes: number;
    plannedMinutes: number;
    netMinutes: number;
  };
  gapTop3: GapRowDto[];
  uncertaintyTop3: GapRowDto[];
  banners: PlannerBanner[];
}

/** 仪表盘：一次取齐，避免页面自行拼 N+1（单用户可接受，但别在组件里再散查）。 */
export async function getPlannerDashboard(asOfDate: string = today()): Promise<PlannerDashboardDto> {
  const { weekStart, weekEnd } = weekRange(asOfDate);
  const weekDates = listDateRange(weekStart, weekEnd);

  const [stage, budget, evidenceCount, profileCount, todayTasks, weekTasks, weekSplits, target, weekBudgets, staleVersionCount] =
    await Promise.all([
      getActiveStage(),
      getEffectiveBudget(asOfDate),
      prisma.evidenceRecord.count({ where: { archivedAt: null } }),
      prisma.skillProfile.count(),
      prisma.planTask.findMany({
        where: { planDate: asOfDate },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          module: true,
          priority: true,
          plannedMinutes: true,
          actualMinutes: true,
          status: true,
        },
      }),
      prisma.planTask.findMany({
        where: { planDate: { gte: weekStart, lte: weekEnd } },
        select: { planDate: true, plannedMinutes: true, status: true },
      }),
      prisma.studySessionDaySplit.groupBy({
        by: ['date'],
        where: { date: { gte: weekStart, lte: weekEnd } },
        _sum: { minutes: true },
      }),
      getWeeklyTarget(weekStart),
      getBudgetRange(weekDates),
      prisma.planVersion.count({ where: { staleAt: { not: null } } }),
    ]);

  const latestSnapshot = await prisma.planningSnapshot.findFirst({
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      purpose: true,
      asOfDate: true,
      createdAt: true,
      ruleVersion: true,
      inputHash: true,
    },
  });

  const diagnosed = evidenceCount > 0 || profileCount > 0;

  // 缺口/不确定：只取 OFFICIAL（G-4），辅助维度不在仪表盘出现
  const snapshotGaps = latestSnapshot
    ? await prisma.skillGap.findMany({
        where: { snapshotId: latestSnapshot.id, dimensionKind: 'OFFICIAL' },
        orderBy: [{ severity: 'desc' }, { skill: 'asc' }],
      })
    : [];

  const gapTop3 = snapshotGaps
    .filter((row) => row.kind === 'GAP')
    .slice(0, 3)
    .map(toGapRow);
  const uncertaintyTop3 = snapshotGaps
    .filter((row) => row.kind !== 'GAP')
    .slice(0, 3)
    .map(toGapRow);

  // 待确认：最近 7 天的生成快照里，没有任何 PlanVersion.snapshotId 指向的那些。
  // 说明：重排预览不落快照（Q4「预览不落库」），因此这里只覆盖生成预览。
  const recentSnapshots = await prisma.planningSnapshot.findMany({
    where: {
      purpose: 'GENERATE',
      createdAt: { gte: new Date(Date.now() - PENDING_WINDOW_DAYS * 86_400_000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, purpose: true, asOfDate: true, createdAt: true },
  });
  const confirmedSnapshotIds = new Set(
    recentSnapshots.length
      ? (
          await prisma.planVersion.findMany({
            where: { snapshotId: { in: recentSnapshots.map((row) => row.id) } },
            select: { snapshotId: true },
          })
        ).flatMap((row) => (row.snapshotId ? [row.snapshotId] : []))
      : [],
  );
  const pendingConfirmations = recentSnapshots
    .filter((row) => !confirmedSnapshotIds.has(row.id))
    .map((row) => ({
      snapshotId: row.id,
      purpose: row.purpose,
      asOfDate: row.asOfDate,
      createdAt: row.createdAt.toISOString(),
    }));

  const todayScheduled = todayTasks.filter((task) => isScheduledStatus(task.status));
  const plannedToday = todayScheduled.reduce((sum, task) => sum + task.plannedMinutes, 0);
  const doneToday = todayTasks
    .filter((task) => task.status === 'DONE')
    .reduce((sum, task) => sum + task.actualMinutes, 0);

  const netByDate = new Map(weekSplits.map((row) => [row.date, row._sum.minutes ?? 0] as const));
  const weekScheduled = weekTasks.filter((task) => isScheduledStatus(task.status));
  const weekPlanned = weekScheduled.reduce((sum, task) => sum + task.plannedMinutes, 0);
  const weekNet = [...netByDate.values()].reduce((sum, value) => sum + value, 0);
  const capacityMinutes = weekDates.reduce(
    (sum, date) => sum + (weekBudgets.get(date)?.minutes ?? 0),
    0,
  );

  const banners: PlannerBanner[] = [];
  if (!diagnosed) {
    banners.push({
      level: 'warning',
      code: 'NO_BASELINE',
      text: '还没有任何证据基线：先做一轮诊断，系统不会凭空排任务。',
    });
  }
  if (budget.isSuggestion) {
    banners.push({
      level: 'info',
      code: 'BUDGET_IS_SUGGESTION',
      text: '当前每日预算还是首次安装的建议值，不是你填的真实可用时间。',
    });
  }
  if (pendingConfirmations.length > 0) {
    banners.push({
      level: 'info',
      code: 'PENDING_CONFIRMATION',
      text: `有 ${pendingConfirmations.length} 次生成预览尚未确认，确认后才会写入计划。`,
    });
  }
  if (staleVersionCount > 0) {
    banners.push({
      level: 'warning',
      code: 'STALE_VERSIONS',
      text: `有 ${staleVersionCount} 个历史版本因上游变化已失效（仍可查看，不会被静默改写）。`,
    });
  }

  const topTasks = [...todayScheduled]
    .sort(
      (a, b) =>
        TASK_PRIORITIES.indexOf(priorityOf(a.priority)) -
        TASK_PRIORITIES.indexOf(priorityOf(b.priority)),
    )
    .slice(0, 5)
    .map((task) => ({
      taskId: task.id,
      moduleLabel: moduleLabelOf(task.module),
      priority: priorityOf(task.priority),
      plannedMinutes: task.plannedMinutes,
      status: task.status as TaskStatus,
    }));

  return {
    asOfDate,
    diagnosed,
    latestSnapshotId: latestSnapshot?.id ?? null,
    statusBand: {
      stageId: stage?.id ?? null,
      stageCode: (stage?.code as StageCode) ?? null,
      stageName: stage?.nameZh ?? null,
      budgetMinutes: budget.minutes,
      isRestDay: budget.isRestDay,
      isSuggestion: budget.isSuggestion,
      plannedMinutes: plannedToday,
      actualNetMinutes: netByDate.get(asOfDate) ?? 0,
      taskCount: todayTasks.length,
      doneCount: todayTasks.filter((task) => task.status === 'DONE').length,
      aiMode: 'off',
      aiNote: '本次由规则生成，AI 未参与',
    },
    todayDecision: {
      plannedMinutes: plannedToday,
      doneMinutes: doneToday,
      taskCount: todayTasks.length,
      p0Count: todayScheduled.filter((task) => priorityOf(task.priority) === 'P0').length,
      p1Count: todayScheduled.filter((task) => priorityOf(task.priority) === 'P1').length,
      top: topTasks,
    },
    pendingConfirmations,
    weeklyGap: {
      weekStart,
      weekEnd,
      targetMinutes: target?.targetMinutes ?? null,
      capacityMinutes,
      plannedMinutes: weekPlanned,
      netMinutes: weekNet,
    },
    gapTop3,
    uncertaintyTop3,
    banners,
  };
}

// ───────────────────────── 2. /planner/evidence 缺口摘要 ─────────────────────────

export interface GapSummaryDto {
  snapshot: {
    id: string;
    purpose: string;
    asOfDate: string;
    ruleVersion: string;
    inputHash: string;
    createdAt: string;
  };
  official: Record<(typeof OFFICIAL_SKILLS)[number], GapRowDto[]>;
  auxiliary: GapRowDto[];
  gapCount: number;
  uncertaintyCount: number;
  candidateCount: number;
}

/** `null` → 最近一次快照（按基准日、生成时间排序；两次排序保证确定性）。 */
async function resolveSnapshotId(snapshotId: string | null): Promise<string | null> {
  if (snapshotId) return snapshotId;
  const row = await prisma.planningSnapshot.findFirst({
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * 缺口摘要：四技能各一组 + 辅助维度单列（**绝不合并成一个平铺列表**）。
 *
 * `snapshotId` 传 `null` 时取「最近一次快照」：页面首次进入没有 `?snapshot=`
 * 参数，不该由 UI 自己再写一条「查最新快照」的查询。
 */
export async function getGapSummary(snapshotId: string | null): Promise<GapSummaryDto | null> {
  const resolvedId = await resolveSnapshotId(snapshotId);
  if (!resolvedId) return null;

  const snapshot = await prisma.planningSnapshot.findUnique({ where: { id: resolvedId } });
  if (!snapshot) return null;

  const [officialRows, auxiliaryRows, candidateCount] = await Promise.all([
    prisma.skillGap.findMany({
      where: { snapshotId: resolvedId, dimensionKind: 'OFFICIAL' },
      orderBy: [{ skill: 'asc' }, { severity: 'desc' }],
    }),
    prisma.skillGap.findMany({
      where: { snapshotId: resolvedId, dimensionKind: 'AUXILIARY' },
      orderBy: [{ skill: 'asc' }, { severity: 'desc' }],
    }),
    prisma.taskCandidate.count({ where: { snapshotId: resolvedId } }),
  ]);

  const official = {
    LISTENING: [] as GapRowDto[],
    READING: [] as GapRowDto[],
    SPEAKING: [] as GapRowDto[],
    WRITING: [] as GapRowDto[],
  };
  for (const row of officialRows) {
    const gap = toGapRow(row);
    if (gap.skill in official) {
      official[gap.skill as keyof typeof official].push(gap);
    }
  }
  const allRows = [...officialRows, ...auxiliaryRows];

  return {
    snapshot: {
      id: snapshot.id,
      purpose: snapshot.purpose,
      asOfDate: snapshot.asOfDate,
      ruleVersion: snapshot.ruleVersion,
      inputHash: snapshot.inputHash,
      createdAt: snapshot.createdAt.toISOString(),
    },
    official,
    auxiliary: auxiliaryRows.map(toGapRow),
    gapCount: allRows.filter((row) => row.kind === 'GAP').length,
    uncertaintyCount: allRows.filter((row) => row.kind !== 'GAP').length,
    candidateCount,
  };
}

// ───────────────────────── 3. /planner/candidates 候选队列 ─────────────────────────

export interface CandidateQueueDto {
  snapshotId: string;
  total: number;
  rows: CandidateRowDto[];
  aiNote: string;
}

/** 候选队列：过滤在库侧完成，排序在内存里做（单快照候选数有限）。 */
export async function getCandidateQueue(
  snapshotId: string | null,
  filter: CandidateFilterInput = {},
): Promise<CandidateQueueDto> {
  const resolvedId = await resolveSnapshotId(snapshotId);
  if (!resolvedId) return { snapshotId: '', total: 0, rows: [], aiNote: '尚无规划快照' };
  // 上下界必须合并成同一个 `estMinutes` 对象：分两次展开时后者会整体覆盖前者，
  // 只填 minMinutes 的过滤会静默失效（测试 `过滤条件逐一生效` 守着这条）。
  const estMinutesFilter =
    filter.minMinutes !== undefined || filter.maxMinutes !== undefined
      ? {
          ...(filter.minMinutes !== undefined ? { gte: filter.minMinutes } : {}),
          ...(filter.maxMinutes !== undefined ? { lte: filter.maxMinutes } : {}),
        }
      : null;

  const rows = await prisma.taskCandidate.findMany({
    where: {
      snapshotId: resolvedId,
      ...(filter.sourceKind ? { sourceKind: filter.sourceKind } : {}),
      ...(filter.skill ? { targetSkill: filter.skill } : {}),
      ...(estMinutesFilter ? { estMinutes: estMinutesFilter } : {}),
      ...(filter.priority ? { decision: { priority: filter.priority } } : {}),
    },
    include: {
      decision: {
        select: {
          priority: true,
          score: true,
          weightsVersion: true,
          factorsJson: true,
          rationale: true,
          consequenceIfSkipped: true,
          eligibility: true,
          blockedReason: true,
        },
      },
    },
  });

  const mapped = rows.map(toCandidateRow);
  mapped.sort((a, b) => {
    // 资格 → 优先级 → 分数 → 身份键：最后一级保证确定性，不允许「同分随机」
    const eligibilityRank = (row: CandidateRowDto) => (row.decision?.eligibility === 'ELIGIBLE' ? 0 : 1);
    const byEligibility = eligibilityRank(a) - eligibilityRank(b);
    if (byEligibility !== 0) return byEligibility;
    const byPriority =
      TASK_PRIORITIES.indexOf(a.decision?.priority ?? 'P1') -
      TASK_PRIORITIES.indexOf(b.decision?.priority ?? 'P1');
    if (byPriority !== 0) return byPriority;
    const byScore = (b.decision?.score ?? 0) - (a.decision?.score ?? 0);
    if (byScore !== 0) return byScore;
    return a.candidateKey.localeCompare(b.candidateKey);
  });

  return {
    snapshotId: resolvedId,
    total: mapped.length,
    rows: mapped,
    aiNote: 'AI 未参与本次排序',
  };
}

// ───────────────────────── 4. /planner/candidates 被排除原因 ─────────────────────────

export type ExcludedReasonCode = 'PREREQUISITE' | 'BUDGET' | 'DUPLICATE' | 'AI_REJECTED';

export interface ExcludedReasonsDto {
  snapshotId: string;
  total: number;
  groups: {
    code: ExcludedReasonCode;
    label: string;
    items: { candidateKey: string; title: string; sourceKind: string; module: string; reason: string | null }[];
  }[];
}

const EXCLUDED_LABEL_ZH: Record<ExcludedReasonCode, string> = {
  PREREQUISITE: '前置条件未满足',
  BUDGET: '超出当日预算',
  DUPLICATE: '与更优先的候选重复',
  AI_REJECTED: 'AI 建议被调度器拒绝',
};

/** 被排除原因：四类分组固定顺序，空组也返回（页面不必判 undefined）。 */
export async function getExcludedReasons(snapshotId: string | null): Promise<ExcludedReasonsDto> {
  const resolvedId = await resolveSnapshotId(snapshotId);
  const rows = resolvedId
    ? await prisma.taskPriorityDecision.findMany({
        where: { snapshotId: resolvedId, eligibility: { not: 'ELIGIBLE' } },
        include: {
          candidate: {
            select: { candidateKey: true, title: true, sourceKind: true, module: true },
          },
        },
        orderBy: [{ priority: 'asc' }, { score: 'desc' }],
      })
    : [];

  const groups: ExcludedReasonsDto['groups'] = (
    ['PREREQUISITE', 'BUDGET', 'DUPLICATE', 'AI_REJECTED'] as const
  ).map((code) => ({ code, label: EXCLUDED_LABEL_ZH[code], items: [] }));

  for (const row of rows) {
    let code: ExcludedReasonCode;
    if (row.eligibility === 'BLOCKED_PREREQUISITE') code = 'PREREQUISITE';
    else if (row.eligibility === 'OVER_BUDGET') code = 'BUDGET';
    else if (row.eligibility === 'DUPLICATE') code = 'DUPLICATE';
    else code = 'AI_REJECTED';

    groups.find((group) => group.code === code)?.items.push({
      candidateKey: row.candidate?.candidateKey ?? row.candidateId,
      title: row.candidate?.title ?? '（候选已被清理）',
      sourceKind: row.candidate?.sourceKind ?? 'UNKNOWN',
      module: row.candidate?.module ?? 'UNKNOWN',
      reason: row.blockedReason,
    });
  }

  return {
    snapshotId: resolvedId ?? '',
    total: groups.reduce((sum, group) => sum + group.items.length, 0),
    groups,
  };
}

// ───────────────────────── 5. /planner/build 构建上下文 ─────────────────────────

export interface BuilderLayerStateDto {
  layer: PlanLayer;
  versionId: string;
  version: number;
  planDate: string;
  budgetMinutes: number;
  staleAt: string | null;
  staleReason: string | null;
  taskCount: number;
  structure: PlanLayerStructure | null;
}

export interface BuilderContextDto {
  horizonDays: number;
  layer: PlanLayer;
  diagnosisReady: boolean;
  disabledLayers: PlanLayer[];
  layers: BuilderLayerStateDto[];
  snapshot: {
    id: string;
    asOfDate: string;
    purpose: string;
    ruleVersion: string;
    officialGapCount: number;
    auxiliaryGapCount: number;
    candidateCount: number;
  } | null;
  budget: { minutes: number; isRestDay: boolean; isSuggestion: boolean };
}

const LAYER_PERIOD_DAYS: Record<PlanLayer, number> = { DAY: 0, WEEK: 6, MONTH: 29, CYCLE: 89 };

/** 构建器上下文：四层各自「最新一版」+ 上层版本 + 快照摘要。 */
export async function getBuilderContext(horizonDays: number, asOfDate: string = today()): Promise<BuilderContextDto> {
  const layer = layerOf(horizonDays);

  const [versions, latestSnapshot, evidenceCount, profileCount, budget] = await Promise.all([
    prisma.planVersion.findMany({
      // createdAt 同毫秒会并列（同一事务里连写两版），必须再加一级确定性排序，
      // 否则「每层最近一版」在并列时是随机行 —— 构建器会显示上一版。
      orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
      take: 200,
      select: {
        id: true,
        layer: true,
        version: true,
        planDate: true,
        budgetMinutes: true,
        staleAt: true,
        staleReason: true,
        afterSnapshot: true,
      },
    }),
    prisma.planningSnapshot.findFirst({
      orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, asOfDate: true, purpose: true, ruleVersion: true },
    }),
    prisma.evidenceRecord.count({ where: { archivedAt: null } }),
    prisma.skillProfile.count(),
    getEffectiveBudget(asOfDate),
  ]);

  const latestByLayer = new Map<PlanLayer, (typeof versions)[number]>();
  for (const row of versions) {
    const rowLayer = (row.layer as PlanLayer | null) ?? 'DAY';
    if (!latestByLayer.has(rowLayer)) latestByLayer.set(rowLayer, row);
  }

  const days = (l: PlanLayer) => LAYER_PERIOD_DAYS[l];
  const taskCounts = await Promise.all(
    (['DAY', 'WEEK'] as const).map(async (l) => {
      const row = latestByLayer.get(l);
      if (!row) return 0;
      return prisma.planTask.count({
        where: {
          planVersion: row.version,
          planDate: { gte: row.planDate, lte: addDays(row.planDate, days(l)) },
        },
      });
    }),
  );

  const layers: BuilderLayerStateDto[] = (['DAY', 'WEEK', 'MONTH', 'CYCLE'] as const).map((l) => {
    const row = latestByLayer.get(l);
    if (!row) {
      return {
        layer: l,
        versionId: '',
        version: 0,
        planDate: '',
        budgetMinutes: 0,
        staleAt: null,
        staleReason: null,
        taskCount: 0,
        structure: null,
      };
    }
    return {
      layer: l,
      versionId: row.id,
      version: row.version,
      planDate: row.planDate,
      budgetMinutes: row.budgetMinutes,
      staleAt: row.staleAt ? row.staleAt.toISOString() : null,
      staleReason: row.staleReason,
      taskCount: l === 'DAY' ? taskCounts[0] : l === 'WEEK' ? taskCounts[1] : 0,
      structure:
        l === 'MONTH' || l === 'CYCLE'
          ? parseJson<PlanLayerStructure | null>(row.afterSnapshot, null)
          : null,
    };
  });

  const diagnosisReady = evidenceCount > 0 || profileCount > 0;
  const disabledLayers: PlanLayer[] = diagnosisReady ? [] : ['MONTH', 'CYCLE'];

  let snapshot: BuilderContextDto['snapshot'] = null;
  if (latestSnapshot) {
    const [officialGapCount, auxiliaryGapCount, candidateCount] = await Promise.all([
      prisma.skillGap.count({ where: { snapshotId: latestSnapshot.id, dimensionKind: 'OFFICIAL' } }),
      prisma.skillGap.count({ where: { snapshotId: latestSnapshot.id, dimensionKind: 'AUXILIARY' } }),
      prisma.taskCandidate.count({ where: { snapshotId: latestSnapshot.id } }),
    ]);
    snapshot = {
      id: latestSnapshot.id,
      asOfDate: latestSnapshot.asOfDate,
      purpose: latestSnapshot.purpose,
      ruleVersion: latestSnapshot.ruleVersion,
      officialGapCount,
      auxiliaryGapCount,
      candidateCount,
    };
  }

  return {
    horizonDays,
    layer,
    diagnosisReady,
    disabledLayers,
    layers,
    snapshot,
    budget: { minutes: budget.minutes, isRestDay: budget.isRestDay, isSuggestion: budget.isSuggestion },
  };
}

// ───────────────────────── 6. /planner/build 草稿 ─────────────────────────

export interface DraftDto {
  draftId: string;
  purpose: string;
  asOfDate: string;
  ruleVersion: string;
  inputHash: string;
  createdAt: string;
  budgetJson: unknown;
  configJson: unknown;
  validationJson: unknown;
  officialGapCount: number;
  auxiliaryGapCount: number;
  candidateCount: number;
}

/** 草稿锚点就是 `PlanningSnapshot`（没有单独的草稿表）。 */
export async function getDraft(draftId: string): Promise<DraftDto | null> {
  const snapshot = await prisma.planningSnapshot.findUnique({ where: { id: draftId } });
  if (!snapshot) return null;

  const [officialGapCount, auxiliaryGapCount, candidateCount] = await Promise.all([
    prisma.skillGap.count({ where: { snapshotId: draftId, dimensionKind: 'OFFICIAL' } }),
    prisma.skillGap.count({ where: { snapshotId: draftId, dimensionKind: 'AUXILIARY' } }),
    prisma.taskCandidate.count({ where: { snapshotId: draftId } }),
  ]);

  return {
    draftId: snapshot.id,
    purpose: snapshot.purpose,
    asOfDate: snapshot.asOfDate,
    ruleVersion: snapshot.ruleVersion,
    inputHash: snapshot.inputHash,
    createdAt: snapshot.createdAt.toISOString(),
    budgetJson: parseJson<unknown>(snapshot.budgetJson, null),
    configJson: parseJson<unknown>(snapshot.configJson, null),
    validationJson: parseJson<unknown>(snapshot.validationJson ?? null, null),
    officialGapCount,
    auxiliaryGapCount,
    candidateCount,
  };
}

// ───────────────────────── 7. /planner/explain 解释与取舍 ─────────────────────────

export interface PlanExplanationTaskDto {
  taskId: string;
  module: string;
  moduleLabel: string;
  skill: string;
  priority: TaskPriority;
  priorityLabel: string;
  status: string;
  plannedMinutes: number;
  actualMinutes: number;
  sourceLabel: string;
  sourceTone: string;
  explanation: {
    reason: string;
    priority: TaskPriority;
    score: number | null;
    factors: Record<string, number> | null;
    weightsVersion: string | null;
    gapRef: { skillGapKey: string; evidenceRefs: string[] } | null;
    estMinutes: number | null;
    minMinutes: number | null;
    prerequisites: string[];
    /**
     * 产出描述。`TaskCandidate.expectedOutput` 只在内存引擎里存在，**没有落列**，
     * 历史版本无法回放 —— 这里恒为 null，UI 必须写「未记录」而不是编造。
     */
    expectedOutput: string | null;
    consequenceIfSkipped: string | null;
    origin: 'RULE' | 'AI';
    wordingSource: 'TEMPLATE';
  };
}

export interface PlanExplanationDto {
  versionId: string;
  planDate: string;
  version: number;
  layer: PlanLayer;
  changeSource: string;
  budgetMinutes: number;
  createdAt: string;
  staleAt: string | null;
  staleReason: string | null;
  snapshot: { id: string; asOfDate: string; purpose: string; ruleVersion: string } | null;
  snapshotMissing: boolean;
  /**
   * 目标参照：`LearningGoal.targetValue`（与 `buildPlanningSnapshot` 同一套确定性排序取行）。
   * `PlanningSnapshot` 未单独保存目标文本，这里是**当前**目标而非版本快照 —— 见 docs/47。
   */
  goalRef: string | null;
  tasks: PlanExplanationTaskDto[];
  layerStructure: PlanLayerStructure | null;
  tradeoffs: {
    totalPlannedMinutes: number;
    p0Ratio: number;
    coreRatio: number;
    extensiveRatio: number;
    /** 被预算挤掉的候选：这里给的是**候选预计分钟**，不是计划分钟（不得混入 I-2 口径）。 */
    excludedByBudget: { title: string; estMinutes: number; reason: string }[];
    uncertaintyDeferred: { skill: string; why: string }[];
  };
  rejectedAiSuggestions: { title: string; reason: string; aiCallLogId: string | null }[];
  aiNote: string;
}

/**
 * 解释与取舍：**逐字读当时的决策快照**（`PlanTask.decisionJson`），
 * 决策行已被清理时退回候选决策行；两者都没有就如实显示「无当时决策」。
 * 计划分钟只来自 `PlanTask.plannedMinutes`，不用候选预计分钟反推（I-2 / F-4）。
 */
export async function getPlanExplanation(versionId: string): Promise<PlanExplanationDto | null> {
  const version = await prisma.planVersion.findUnique({ where: { id: versionId } });
  if (!version) return null;

  const layer = (version.layer as PlanLayer | null) ?? 'DAY';
  const periodEnd = addDays(version.planDate, LAYER_PERIOD_DAYS[layer]);
  const hasDailyTasks = layer === 'DAY' || layer === 'WEEK';

  const [tasks, snapshot, decisions, goalRow] = await Promise.all([
    hasDailyTasks
      ? prisma.planTask.findMany({
          where: {
            planVersion: version.version,
            planDate: { gte: version.planDate, lte: periodEnd },
          },
          orderBy: [{ planDate: 'asc' }, { sortOrder: 'asc' }],
        })
      : Promise.resolve([]),
    version.snapshotId
      ? prisma.planningSnapshot.findUnique({
          where: { id: version.snapshotId },
          select: { id: true, asOfDate: true, purpose: true, ruleVersion: true },
        })
      : Promise.resolve(null),
    prisma.taskPriorityDecision.findMany({
      where: { snapshotId: version.snapshotId ?? '' },
      include: {
        candidate: { select: { id: true, title: true, sourceKind: true, module: true, estMinutes: true } },
      },
    }),
    // 目标行的选取必须与 `services/planningSnapshot.ts` ① 的 orderBy 一致：
    // seed 里有 3 条 ACTIVE，不排序时取到哪条由插入顺序决定，换机器就变。
    prisma.learningGoal.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { targetValue: true },
    }),
  ]);

  const candidateIds = [...new Set(tasks.flatMap((task) => (task.candidateId ? [task.candidateId] : [])))];
  const candidates = candidateIds.length
    ? await prisma.taskCandidate.findMany({
        where: { id: { in: candidateIds } },
        select: {
          id: true,
          sourceKind: true,
          module: true,
          estMinutes: true,
          minMinutes: true,
          prerequisitesJson: true,
          isAiSuggested: true,
          aiCallLogId: true,
        },
      })
    : [];
  const candidateById = new Map(candidates.map((row) => [row.id, row] as const));
  const decisionByCandidateId = new Map(decisions.map((row) => [row.candidateId, row] as const));

  const explanationTasks: PlanExplanationTaskDto[] = tasks.map((task) => {
    const candidate = task.candidateId ? (candidateById.get(task.candidateId) ?? null) : null;
    const decision = task.candidateId ? (decisionByCandidateId.get(task.candidateId) ?? null) : null;
    const fromTask = parseJson<{
      factors?: Record<string, number>;
      score?: number;
      priority?: string;
      rationale?: string;
    }>(task.decisionJson, {});
    const fromDecision = decision
      ? parseJson<{ factors?: Record<string, number>; meta?: DecisionMetaShape }>(decision.factorsJson, {})
      : {};
    const badge = resolveSourceBadge(
      {
        sourceKind: task.sourceKind as TaskSourceKind,
        module: task.module as ModuleId,
        candidateId: task.candidateId,
      },
      candidate ? { sourceKind: candidate.sourceKind as CandidateSourceKind } : null,
    );
    const priority = priorityOf(fromTask.priority ?? decision?.priority ?? task.priority);
    return {
      taskId: task.id,
      module: task.module,
      moduleLabel: moduleLabelOf(task.module),
      skill: task.skill,
      priority,
      priorityLabel: TASK_PRIORITY_LABEL_ZH[priority] ?? priority,
      status: task.status,
      plannedMinutes: task.plannedMinutes,
      actualMinutes: task.actualMinutes,
      sourceLabel: badge.label,
      sourceTone: badge.tone,
      explanation: {
        // 不重算：优先取写入时的快照，其次取决策行，最后才是任务备注
        reason: fromTask.rationale ?? decision?.rationale ?? task.note ?? '（当时没有记录推荐原因）',
        priority,
        score: fromTask.score ?? decision?.score ?? null,
        factors: fromTask.factors ?? fromDecision.factors ?? null,
        weightsVersion: decision?.weightsVersion ?? null,
        gapRef: fromDecision.meta?.skillGapKey
          ? {
              skillGapKey: fromDecision.meta.skillGapKey,
              evidenceRefs: fromDecision.meta.evidenceRefs ?? [],
            }
          : null,
        estMinutes: candidate?.estMinutes ?? null,
        minMinutes: candidate?.minMinutes ?? null,
        prerequisites: parseStringArray(candidate?.prerequisitesJson ?? null),
        expectedOutput: null,
        consequenceIfSkipped: decision?.consequenceIfSkipped ?? null,
        origin: candidate?.isAiSuggested ? 'AI' : 'RULE',
        wordingSource: 'TEMPLATE',
      },
    };
  });

  const scheduled = explanationTasks.filter((task) => isScheduledStatus(task.status));
  const totalPlannedMinutes = scheduled.reduce((sum, task) => sum + task.plannedMinutes, 0);
  const ratio = (predicate: (task: PlanExplanationTaskDto) => boolean) =>
    totalPlannedMinutes > 0
      ? scheduled.filter(predicate).reduce((sum, task) => sum + task.plannedMinutes, 0) / totalPlannedMinutes
      : 0;

  const excludedByBudget = decisions
    .filter((row) => row.eligibility === 'OVER_BUDGET')
    .map((row) => ({
      title: row.candidate?.title ?? '（候选已被清理）',
      estMinutes: row.candidate?.estMinutes ?? 0,
      reason: row.blockedReason ?? '超出当日预算',
    }));

  return {
    versionId: version.id,
    planDate: version.planDate,
    version: version.version,
    layer,
    changeSource: version.changeSource,
    budgetMinutes: version.budgetMinutes,
    createdAt: version.createdAt.toISOString(),
    staleAt: version.staleAt ? version.staleAt.toISOString() : null,
    staleReason: version.staleReason,
    snapshot,
    snapshotMissing: Boolean(version.snapshotId) && !snapshot,
    goalRef: goalRow?.targetValue ?? null,
    tasks: explanationTasks,
    layerStructure:
      layer === 'MONTH' || layer === 'CYCLE'
        ? parseJson<PlanLayerStructure | null>(version.afterSnapshot, null)
        : null,
    tradeoffs: {
      totalPlannedMinutes,
      p0Ratio: ratio((task) => task.priority === 'P0'),
      coreRatio: ratio((task) => task.priority === 'P1' || task.priority === 'P2'),
      extensiveRatio: ratio((task) => task.priority === 'P3'),
      excludedByBudget,
      uncertaintyDeferred: [],
    },
    rejectedAiSuggestions: decisions
      .filter((row) => row.eligibility === 'REJECTED_NOT_IN_POOL' || row.eligibility === 'REJECTED_AI_OVER_BUDGET')
      .map((row) => ({
        title: row.candidate?.title ?? '（候选已被清理）',
        reason: row.blockedReason ?? row.eligibility,
        aiCallLogId: null,
      })),
    aiNote: '本次由规则生成，AI 未参与',
  };
}

// ───────────────────────── 8. /planner/budget 周预算 ─────────────────────────

export interface BudgetDayRowDto {
  date: string;
  budgetMinutes: number;
  isRestDay: boolean;
  source: string;
  tierCode: string | null;
  isInitialSuggestion: boolean;
  plannedMinutes: number;
  netMinutes: number;
  taskCount: number;
  doneCount: number;
}

export interface BudgetWeekDto {
  weekStart: string;
  weekEnd: string;
  days: BudgetDayRowDto[];
  totals: { budgetMinutes: number; plannedMinutes: number; netMinutes: number };
  isFirstInstallSuggestion: boolean;
}

/** 周预算：预算来自 `getBudgetRange`（唯一解析口）；实际仍只从 DaySplit 求和。 */
export async function getBudgetWeek(weekStart: string): Promise<BudgetWeekDto> {
  const weekEnd = addDays(weekStart, 6);
  const dates = listDateRange(weekStart, weekEnd);

  const [budgets, tasks, splits] = await Promise.all([
    getBudgetRange(dates),
    prisma.planTask.findMany({
      where: { planDate: { gte: weekStart, lte: weekEnd } },
      select: { planDate: true, plannedMinutes: true, status: true },
    }),
    prisma.studySessionDaySplit.groupBy({
      by: ['date'],
      where: { date: { gte: weekStart, lte: weekEnd } },
      _sum: { minutes: true },
    }),
  ]);

  const netByDate = new Map(splits.map((row) => [row.date, row._sum.minutes ?? 0] as const));
  const days: BudgetDayRowDto[] = dates.map((date) => {
    const budget = budgets.get(date);
    const dayTasks = tasks.filter((task) => task.planDate === date);
    const scheduled = dayTasks.filter((task) => isScheduledStatus(task.status));
    return {
      date,
      budgetMinutes: budget?.minutes ?? 0,
      isRestDay: budget?.isRestDay ?? false,
      source: budget?.source ?? 'DEFAULT_SUGGESTION',
      tierCode: budget?.tierCode ?? null,
      isInitialSuggestion: budget?.isSuggestion ?? false,
      plannedMinutes: scheduled.reduce((sum, task) => sum + task.plannedMinutes, 0),
      netMinutes: netByDate.get(date) ?? 0,
      taskCount: dayTasks.length,
      doneCount: dayTasks.filter((task) => task.status === 'DONE').length,
    };
  });

  return {
    weekStart,
    weekEnd,
    days,
    totals: {
      budgetMinutes: days.reduce((sum, day) => sum + day.budgetMinutes, 0),
      plannedMinutes: days.reduce((sum, day) => sum + day.plannedMinutes, 0),
      netMinutes: days.reduce((sum, day) => sum + day.netMinutes, 0),
    },
    isFirstInstallSuggestion: days.some((day) => day.isInitialSuggestion),
  };
}

/** 周目标摘要（周目标 + 最近四周 + 本周实际净分钟）。 */
export interface WeeklyTargetSummaryDto {
  weekStart: string;
  weekEnd: string;
  targetMinutes: number | null;
  status: string | null;
  source: string | null;
  note: string | null;
  actualNetMinutes: number;
  allocations: { date: string; availableMinutes: number; isRestDay: boolean }[];
  recent: { weekStart: string; targetMinutes: number; status: string }[];
}

export async function getWeeklyTargetSummary(weekStart: string): Promise<WeeklyTargetSummaryDto> {
  const weekEnd = addDays(weekStart, 6);
  const [target, recentTargets, splits] = await Promise.all([
    getWeeklyTarget(weekStart),
    listRecentWeeklyTargets(weekStart, 4),
    prisma.studySessionDaySplit.aggregate({
      where: { date: { gte: weekStart, lte: weekEnd } },
      _sum: { minutes: true },
    }),
  ]);

  return {
    weekStart,
    weekEnd,
    targetMinutes: target?.targetMinutes ?? null,
    status: target?.status ?? null,
    source: target?.source ?? null,
    note: target?.note ?? null,
    actualNetMinutes: splits._sum.minutes ?? 0,
    allocations: (target?.allocations ?? []).map((row) => ({
      date: row.date,
      availableMinutes: row.availableMinutes,
      isRestDay: row.isRestDay,
    })),
    recent: recentTargets.map((row) => ({
      weekStart: row.weekStart,
      targetMinutes: row.targetMinutes,
      status: row.status,
    })),
  };
}

// ───────────────────────── 9. /planner/replan 重排上下文 ─────────────────────────

export interface ReplanContextDto {
  planDate: string;
  hasTasks: boolean;
  budget: { minutes: number; isRestDay: boolean };
  actualNetMinutes: number;
  versionCount: number;
  lastVersion: number | null;
  protectedTaskIds: string[];
  tasks: {
    taskId: string;
    module: string;
    moduleLabel: string;
    plannedMinutes: number;
    actualMinutes: number;
    status: string;
    priority: TaskPriority;
    timerStatus: TimerStatus;
    protected: boolean;
  }[];
}

/** 重排上下文：已完成 / 计时中 / 已产生实际分钟的任务受保护，预览不得改动它们。 */
export async function getReplanContext(planDate: string): Promise<ReplanContextDto> {
  const [budget, tasks, splits, versionAgg, lastVersion] = await Promise.all([
    getEffectiveBudget(planDate),
    prisma.planTask.findMany({
      where: { planDate },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        module: true,
        plannedMinutes: true,
        actualMinutes: true,
        status: true,
        priority: true,
        timerStatus: true,
      },
    }),
    prisma.studySessionDaySplit.aggregate({
      where: { date: planDate },
      _sum: { minutes: true },
    }),
    prisma.planVersion.count({ where: { planDate } }),
    prisma.planVersion.findFirst({
      where: { planDate },
      orderBy: { version: 'desc' },
      select: { version: true },
    }),
  ]);

  const rows = tasks.map((task) => {
    const isProtected =
      task.status === 'DONE' ||
      task.actualMinutes > 0 ||
      task.timerStatus === 'RUNNING' ||
      task.timerStatus === 'PAUSED';
    return {
      taskId: task.id,
      module: task.module,
      moduleLabel: moduleLabelOf(task.module),
      plannedMinutes: task.plannedMinutes,
      actualMinutes: task.actualMinutes,
      status: task.status,
      priority: priorityOf(task.priority),
      timerStatus: task.timerStatus as TimerStatus,
      protected: isProtected,
    };
  });

  return {
    planDate,
    hasTasks: rows.length > 0,
    budget: { minutes: budget.minutes, isRestDay: budget.isRestDay },
    actualNetMinutes: splits._sum.minutes ?? 0,
    versionCount: versionAgg,
    lastVersion: lastVersion?.version ?? null,
    protectedTaskIds: rows.filter((row) => row.protected).map((row) => row.taskId),
    tasks: rows,
  };
}

// ───────────────────────── 10. /planner/readiness 阶段就绪 ─────────────────────────

/** 评审快照里的五维明细（与 `domain/readiness.ReadinessDimension` 同构）。 */
export interface ReadinessDimensionRowDto {
  code: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT' | 'READ_ERROR';
  detail: string;
  evidenceRefs: string[];
}

export interface ReadinessViewDto {
  stage: { id: string; code: StageCode; nameZh: string; status: string; startDate: string | null } | null;
  latestReview: {
    id: string;
    outcome: string;
    ruleVersion: string;
    createdAt: string;
    userConfirmed: boolean;
    confirmedAt: string | null;
    confirmedBy: string | null;
    note: string | null;
    /** 五维证据明细（`StageReadinessReview.criteriaJson` 的原文回放）。 */
    criteria: ReadinessDimensionRowDto[];
    evidenceRefs: string[];
    unmet: string[];
  } | null;
  gate: GateResult | null;
  evidenceCount: number;
  /** 只用于展示：这些指标**不参与**判定（PRD §4.9③）；`value` 是它们的当前值。 */
  notConsidered: { label: string; value: string; note: string }[];
}

/**
 * 「不参与判定」的指标要显示**当前值** —— 只写一句「不参与判定」用户看不出
 * 它们现在有多好看。值由 `getReadinessView` 现场聚合（纯展示，不进任何判定）。
 */
function buildNotConsidered(input: {
  studyDays: number;
  completionText: string;
  aiScoreText: string;
}): { label: string; value: string; note: string }[] {
  return [
    { label: '学习天数', value: `${input.studyDays} 天`, note: '不参与判定' },
    { label: '完成率', value: input.completionText, note: '不参与判定' },
    { label: '单次 AI 分数', value: input.aiScoreText, note: '不参与判定' },
  ];
}

/** 阶段就绪视图：只读最近一次评审快照 + 验收门禁；不在这里重算结论（G-7）。 */
export async function getReadinessView(stageId: string): Promise<ReadinessViewDto | null> {
  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage) return null;

  const [review, gate, evidenceCount, studyDayRows, recentTasks] = await Promise.all([
    prisma.stageReadinessReview.findFirst({
      where: { stageId },
      orderBy: { createdAt: 'desc' },
    }),
    getStageGate(stageId),
    prisma.evidenceRecord.count({ where: { archivedAt: null } }),
    prisma.studySessionDaySplit.groupBy({
      by: ['date'],
      where: { date: { gte: stage.startedAt ?? '1970-01-01' } },
      _sum: { minutes: true },
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: addDays(today(), -6) } },
      select: { status: true, plannedMinutes: true, actualMinutes: true, movedFromDate: true },
    }),
  ]);

  const studyDays = studyDayRows.filter((row) => (row._sum.minutes ?? 0) > 0).length;
  const rate = completionRate(
    recentTasks.map((row) => ({ ...row, status: row.status as TaskStatus })),
  );
  const completionText =
    rate.byTime === null ? '近 7 天无计划任务' : `${Math.round(rate.byTime * 100)}%（近 7 天，按时长加权）`;

  return {
    stage: {
      id: stage.id,
      code: stage.code as StageCode,
      nameZh: stage.nameZh,
      status: stage.status,
      startDate: stage.startedAt ?? null,
    },
    latestReview: review
      ? {
          id: review.id,
          outcome: review.outcome,
          ruleVersion: review.ruleVersion,
          createdAt: review.createdAt.toISOString(),
          userConfirmed: review.userConfirmed,
          confirmedAt: review.confirmedAt ? review.confirmedAt.toISOString() : null,
          confirmedBy: review.confirmedBy,
          note: review.note,
          criteria: parseJson<ReadinessDimensionRowDto[]>(review.criteriaJson, []),
          evidenceRefs: parseStringArray(review.evidenceRefsJson),
          unmet: parseStringArray(review.unmetJson),
        }
      : null,
    gate,
    evidenceCount,
    notConsidered: buildNotConsidered({
      studyDays,
      completionText,
      aiScoreText: '当前没有 AI 评分记录',
    }),
  };
}

// ───────────────────────── 11. /planner/history 版本历史与对比 ─────────────────────────

export interface VersionHistoryFilter {
  layer?: PlanLayer | 'ALL';
  from?: string;
  to?: string;
  limit?: number;
}

export interface VersionHistoryRowDto {
  id: string;
  planDate: string;
  version: number;
  layer: PlanLayer;
  changeSource: string;
  reason: string | null;
  budgetMinutes: number;
  snapshotId: string | null;
  parentVersionId: string | null;
  staleAt: string | null;
  staleReason: string | null;
  createdAt: string;
  aiInvolved: boolean;
}

/** 版本历史（append-only；冻结行不会被后续操作改写）。 */
export async function getVersionHistory(filter: VersionHistoryFilter = {}): Promise<VersionHistoryRowDto[]> {
  const layer = filter.layer ?? 'ALL';
  const rows = await prisma.planVersion.findMany({
    where: {
      ...(filter.from || filter.to
        ? { planDate: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
      ...(layer === 'ALL' ? {} : layer === 'DAY' ? { layer: null } : { layer }),
    },
    orderBy: [{ planDate: 'desc' }, { version: 'desc' }, { createdAt: 'desc' }],
    take: filter.limit ?? 50,
  });

  return rows.map((row) => toVersionMeta(row));
}

export interface VersionDiffRowDto {
  module: string;
  moduleLabel: string;
  beforeMinutes: number;
  afterMinutes: number;
  beforeCount: number;
  afterCount: number;
  deltaMinutes: number;
}

export interface VersionDiffDto {
  before: VersionHistoryRowDto;
  after: VersionHistoryRowDto;
  rows: VersionDiffRowDto[];
}

function toVersionMeta(row: {
  id: string;
  planDate: string;
  version: number;
  layer: string | null;
  changeSource: string;
  reason: string | null;
  budgetMinutes: number;
  snapshotId: string | null;
  parentVersionId: string | null;
  staleAt: Date | null;
  staleReason: string | null;
  createdAt: Date;
}): VersionHistoryRowDto {
  return {
    id: row.id,
    planDate: row.planDate,
    version: row.version,
    layer: (row.layer as PlanLayer | null) ?? 'DAY',
    changeSource: row.changeSource,
    reason: row.reason,
    budgetMinutes: row.budgetMinutes,
    snapshotId: row.snapshotId,
    parentVersionId: row.parentVersionId,
    staleAt: row.staleAt ? row.staleAt.toISOString() : null,
    staleReason: row.staleReason,
    createdAt: row.createdAt.toISOString(),
    // v2.7 生成链路目前恒为规则（T07）；AI 参与的版本在 T14 接入后由 rejectedAiSuggestions/aiNote 体现
    aiInvolved: false,
  };
}

/** 两版对比：按模块汇总计划分钟（只比计划，不比实际 —— 实际是事实，不随版本变）。 */
export async function getVersionDiff(
  beforeVersionId: string,
  afterVersionId: string,
): Promise<VersionDiffDto | null> {
  const versions = await prisma.planVersion.findMany({
    where: { id: { in: [beforeVersionId, afterVersionId] } },
  });
  const before = versions.find((row) => row.id === beforeVersionId);
  const after = versions.find((row) => row.id === afterVersionId);
  if (!before || !after) return null;

  const tasks = await prisma.planTask.findMany({
    where: { planVersion: { in: [before.version, after.version] } },
    select: { planVersion: true, planDate: true, module: true, plannedMinutes: true, status: true },
  });

  const rowsFor = (version: typeof before) => {
    const periodEnd = addDays(version.planDate, LAYER_PERIOD_DAYS[(version.layer as PlanLayer | null) ?? 'DAY']);
    return tasks.filter(
      (task) =>
        task.planVersion === version.version &&
        task.planDate >= version.planDate &&
        task.planDate <= periodEnd &&
        isScheduledStatus(task.status),
    );
  };

  const beforeRows = rowsFor(before);
  const afterRows = rowsFor(after);
  const modules = [...new Set([...beforeRows, ...afterRows].map((row) => row.module))].sort();

  const rows: VersionDiffRowDto[] = modules.map((module) => {
    const beforeMinutes = beforeRows
      .filter((row) => row.module === module)
      .reduce((sum, row) => sum + row.plannedMinutes, 0);
    const afterMinutes = afterRows
      .filter((row) => row.module === module)
      .reduce((sum, row) => sum + row.plannedMinutes, 0);
    return {
      module,
      moduleLabel: moduleLabelOf(module),
      beforeMinutes,
      afterMinutes,
      beforeCount: beforeRows.filter((row) => row.module === module).length,
      afterCount: afterRows.filter((row) => row.module === module).length,
      deltaMinutes: afterMinutes - beforeMinutes,
    };
  });

  return { before: toVersionMeta(before), after: toVersionMeta(after), rows };
}

export interface SnapshotProvenanceDto {
  id: string;
  asOfDate: string;
  purpose: string;
  ruleVersion: string;
  createdAt: string;
}

/**
 * 批量取快照溯源（`/planner/history` 用）。
 *
 * 返回 Map 语义：**键缺失 = 快照已被清理**，与「行本身没有 snapshotId」区分开，
 * 避免把「旧版没记快照」误标成「快照丢了」。
 */
export async function getSnapshotProvenanceMap(
  snapshotIds: string[],
): Promise<Record<string, SnapshotProvenanceDto>> {
  const ids = [...new Set(snapshotIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return {};
  const rows = await prisma.planningSnapshot.findMany({
    where: { id: { in: ids } },
    select: { id: true, asOfDate: true, purpose: true, ruleVersion: true, createdAt: true },
  });
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        asOfDate: row.asOfDate,
        purpose: row.purpose,
        ruleVersion: row.ruleVersion,
        createdAt: row.createdAt.toISOString(),
      },
    ]),
  );
}