/**
 * Dashboard 聚合查询。
 *
 * 硬要求（PRD P0-13 / G5）：12 个区块的每个数字都必须由数据库聚合得出，
 * 不允许任何硬编码或 mock。本模块是唯一装配点：
 *
 * ① 状态条 ② 四类量分区 ③ 今日 ④ 本周 ⑤ 四项投入 ⑥ 语法与词汇
 * ⑦ 待复习 ⑧ 7/30 天趋势 ⑨ 薄弱点 Top3 ⑩ 下一阶段验收完成度
 *
 * 口径注意：
 * - 日净时长**只**从 `StudySessionDaySplit` 求和；
 * - 趋势空缺日为 `null`（折线断点），绝不补 0；
 * - 正确率一律加权（`weightedAccuracy`），不对 accuracy 数组取平均；
 * - 泛听泛读只进 `EXTENSIVE` 桶。
 */

import {
  MODULE_META,
  SKILL_LABEL_ZH,
  WEAKNESS_MIN_QUESTIONS,
  WEAKNESS_TOP_N,
  WEAKNESS_WINDOW_DAYS,
} from '@/lib/constants';
import {
  addDays,
  dayOfWeek,
  diffDays,
  lastNDays,
  listDateRange,
  weekRange,
} from '@/lib/date';
import { resolveBusinessDate } from '@/lib/businessTime';
import { mergeSampleTotals } from '@/lib/domain/accuracy';
import { effectiveOutputCount, completionRate } from '@/lib/domain/completion';
import { accumulatePrimaryMinutes, defaultAllocationFor } from '@/lib/domain/allocation';
import { skillMinutes } from '@/lib/domain/duration';
import { colorDistribution, overdueDays } from '@/lib/domain/review';
import { evaluateStageGate } from '@/lib/domain/stageGate';
import { getBudgetRange } from '@/lib/queries/budget';
import { rankWeaknesses, type WeaknessCandidate } from '@/lib/domain/weakness';
import { parseObject } from '@/lib/json';
import { estimateOfTaskDecision, expectedOutputOfTaskDecision, parseTaskDecisionJson } from '@/lib/domain/taskDecision';
import { prisma } from '@/lib/prisma';
import type {
  ColorDistributionDto,
  CompletionItem,
  DashboardDto,
  DashboardZoneDto,
  EgiuColor,
  GatePanelDto,
  IntervalCode,
  MasteryDistributionDto,
  MasteryLevel,
  ModuleId,
  ReviewDebtDto,
  ReviewResult,
  ReviewStatus,
  SkillId,
  StageCode,
  StageProfileCode,
  TaskStatus,
  TrendPointDto,
} from '@/lib/types';
import { getActiveStage } from './stages';
import { getProfile } from './profile';
import { sweepStaleTasks } from './plan';

/** 统计窗口内「有计划的日期」需要用到计划的日期集合。 */
const DAY_MS = 86_400_000;

/** 验收项的投影（`Promise.all` 里的空分支需要显式类型，避免推断成 `never[]`）。 */
interface AcceptanceRow {
  dimension: string;
  isRequired: boolean;
  verdict: string;
  myResult: string | null;
  evidence: string | null;
  judgedAt: string | null;
}

function toCompletionItems(
  tasks: { plannedMinutes: number; actualMinutes: number; status: string; movedFromDate: string | null; movedToDate: string | null }[],
): CompletionItem[] {
  return tasks.map((task) => ({
    plannedMinutes: task.plannedMinutes,
    actualMinutes: task.actualMinutes,
    status: task.status as TaskStatus,
    movedFromDate: task.movedFromDate,
    movedToDate: task.movedToDate,
  }));
}
/** 趋势序列：空缺日 `minutes = null`。 */
function buildTrend(dates: string[], minutesByDate: Map<string, number>): TrendPointDto[] {
  return dates.map((date) => ({
    date,
    minutes: minutesByDate.has(date) ? (minutesByDate.get(date) ?? 0) : null,
  }));
}

/** 从 `ext` 里取口语录音链接与英文摘要（用于有效产出判定）。 */
function extSignals(extRaw: string | null): { recordingUrl: string | null; summaryEn: string | null } {
  const ext = parseObject<Record<string, unknown>>(extRaw, {});
  const recordingUrl = typeof ext.recording_url === 'string' ? ext.recording_url : null;
  const summaryEn = typeof ext.summary_en === 'string' ? ext.summary_en : null;
  return { recordingUrl, summaryEn };
}

/** Dashboard 全量装配。 */
export async function getDashboard(nowDateParam?: string): Promise<DashboardDto> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  await sweepStaleTasks(nowDate);

  const profile = await getProfile();
  const stage = await getActiveStage();
  const week = weekRange(nowDate);
  const prevWeek = weekRange(addDays(week.weekStart, -7));
  const from30 = addDays(nowDate, -29);
  const fromWindow = addDays(nowDate, -(WEAKNESS_WINDOW_DAYS - 1));

  const [
    todayTasks,
    weekTasks,
    splitRows30,
    weekSessions,
    todayRecords,
    weekRecords,
    lessons,
    vocabByMastery,
    vocabTotal,
    vocabNewThisWeek,
    latestQuiz,
    pendingReviews,
    windowRecords,
    windowTasks,
    windowMistakes,
    acceptanceItems,
    reviewTasksForGate,
    plannedDatesRaw,
    weekPlannedRows,
  ] = await Promise.all([
    prisma.planTask.findMany({
      where: { planDate: nowDate },
      orderBy: [{ sortOrder: 'asc' }],
      select: {
        id: true,
        module: true,
        plannedMinutes: true,
        actualMinutes: true,
        status: true,
        movedFromDate: true,
        movedToDate: true,
        decisionJson: true,
      },
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: week.weekStart, lte: week.weekEnd } },
      select: {
        plannedMinutes: true,
        actualMinutes: true,
        status: true,
        movedFromDate: true,
        movedToDate: true,
      },
    }),
    prisma.studySessionDaySplit.groupBy({
      by: ['date'],
      where: { date: { gte: from30, lte: nowDate } },
      _sum: { minutes: true },
    }),
    prisma.studySession.findMany({
      where: { daySplits: { some: { date: { gte: week.weekStart, lte: week.weekEnd } } } },
      select: {
        // v2.0：技能直接读 session 快照，不再 join task ——
        // 媒介学习等「不挂计划任务」的 session 也必须能进入四技能统计。
        skill: true,
        track: true,
        daySplits: { select: { date: true, minutes: true } },
      },
    }),
    prisma.studyRecord.findMany({
      where: { archivedAt: null, recordDate: nowDate },
      select: {
        id: true,
        totalQuestions: true,
        correctQuestions: true,
        outputText: true,
        problemText: true,
        ext: true,
        _count: { select: { mistakes: true } },
      },
    }),
    prisma.studyRecord.findMany({
      where: { archivedAt: null, recordDate: { gte: week.weekStart, lte: week.weekEnd } },
      select: {
        totalQuestions: true,
        correctQuestions: true,
        outputText: true,
        problemText: true,
        ext: true,
        _count: { select: { mistakes: true } },
      },
    }),
    prisma.egiuLesson.findMany({
      where: { archivedAt: null },
      select: { id: true, currentColor: true, knowledgePoint: true },
    }),
    prisma.vocabWord.groupBy({
      by: ['mastery'],
      where: { archivedAt: null },
      _count: { _all: true },
    }),
    prisma.vocabWord.count({ where: { archivedAt: null } }),
    prisma.vocabWord.count({
      where: { archivedAt: null, learnedDate: { gte: week.weekStart, lte: week.weekEnd } },
    }),
    prisma.vocabQuiz.findFirst({ orderBy: { createdAt: 'desc' } }),
    prisma.reviewTask.findMany({
      where: { status: 'PENDING' },
      select: { id: true, targetLabel: true, intervalCode: true, dueDate: true, knowledgePoint: true, estMinutes: true },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.studyRecord.findMany({
      where: { archivedAt: null, recordDate: { gte: fromWindow, lte: nowDate } },
      select: { skill: true, totalQuestions: true, correctQuestions: true },
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: fromWindow, lte: nowDate } },
      select: { planDate: true, skill: true, plannedMinutes: true, actualMinutes: true },
    }),
    prisma.mistake.findMany({
      where: { archivedAt: null, createdAt: { gte: new Date(Date.now() - WEAKNESS_WINDOW_DAYS * DAY_MS) } },
      select: {
        knowledgePoint: true,
        errorCategory: true,
        studyRecord: { select: { totalQuestions: true } },
      },
    }),
    // 显式断言为 `Promise<AcceptanceRow[]>`：三元两支的元素类型必须归一，
    // 否则 `Promise.all` 会推断出 `T[] | AcceptanceRow[]` 的交叉签名，`.map` 报错。
    (stage
      ? prisma.stageAcceptanceItem.findMany({
          where: { stageId: stage.id },
          select: {
            dimension: true,
            isRequired: true,
            verdict: true,
            myResult: true,
            evidence: true,
            judgedAt: true,
          },
        })
      : Promise.resolve([] as AcceptanceRow[])) as Promise<AcceptanceRow[]>,
    prisma.reviewTask.findMany({
      where: { dueDate: { gte: addDays(nowDate, -14), lte: nowDate } },
      select: { intervalCode: true, status: true, dueDate: true, result: true },
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: from30, lte: nowDate } },
      select: { planDate: true },
      distinct: ['planDate'],
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: week.weekStart, lte: week.weekEnd } },
      select: { planDate: true, plannedMinutes: true, status: true },
    }),
  ]);

  // ───────── 净时长 ─────────
  const minutesByDate = new Map<string, number>();
  for (const row of splitRows30) {
    minutesByDate.set(row.date, row._sum.minutes ?? 0);
  }
  const todayNet = minutesByDate.get(nowDate) ?? 0;
  const weekNet = listDateRange(week.weekStart, week.weekEnd).reduce(
    (sum, date) => sum + (minutesByDate.get(date) ?? 0),
    0,
  );

  const prevWeekAggregate = await prisma.studySessionDaySplit.aggregate({
    where: { date: { gte: prevWeek.weekStart, lte: prevWeek.weekEnd } },
    _sum: { minutes: true },
  });
  const prevNetMinutes = prevWeekAggregate._sum.minutes ?? 0;

  // ───────── 四项投入（本周，按 session 的 daySplit 精确归属） ─────────
  const skillRows: { skill: SkillId; minutes: number }[] = [];
  for (const session of weekSessions) {
    const minutesInWeek = session.daySplits
      .filter((split) => split.date >= week.weekStart && split.date <= week.weekEnd)
      .reduce((sum, split) => sum + split.minutes, 0);
    if (minutesInWeek <= 0) continue;
    skillRows.push({ skill: session.skill as SkillId, minutes: minutesInWeek });
  }
  const investment = skillMinutes(skillRows);

  // ───────── 四技能配比（v2.0）：分母只含四项专项训练 ─────────
  // 技能快照直接用 session.skill（PrimarySkill），不经 SKILL_BUCKET，
  // 这样「泛听泛读(EXTENSIVE)/词汇/语法」天然落在 FOUNDATION 之外。
  const primaryRows = weekSessions.map((session) => ({
    skill: session.skill,
    minutes: session.daySplits
      .filter((split) => split.date >= week.weekStart && split.date <= week.weekEnd)
      .reduce((sum, split) => sum + split.minutes, 0),
  }));
  const primaryMinutes = accumulatePrimaryMinutes(primaryRows);

  // ───────── 完成率 ─────────
  // 今日传入 viewDate，与计划页同一口径（已顺延离开当日的任务不进分母）；
  // 本周是「全周合并分子分母」，不做单日剔除。
  const todayCompletion = completionRate(toCompletionItems(todayTasks), nowDate);
  const weekCompletion = completionRate(toCompletionItems(weekTasks));
  const doneTasks = todayTasks.filter((task) => task.status === 'DONE').length;
  const remainingMinutes = todayTasks
    .filter((task) => task.status !== 'DONE')
    .reduce((sum, task) => sum + Math.max(0, task.plannedMinutes - task.actualMinutes), 0);
  const nextTask = todayTasks.find((task) => task.status === 'TODO' || task.status === 'IN_PROGRESS');
  const nextDecision = nextTask ? parseTaskDecisionJson(nextTask.decisionJson) : {};

  // ───────── 有效产出 ─────────
  const toOutputSignals = (
    records: {
      totalQuestions: number;
      outputText: string | null;
      problemText: string | null;
      ext: string | null;
      _count: { mistakes: number };
    }[],
  ) =>
    records.map((record) => {
      const signals = extSignals(record.ext);
      return {
        totalQuestions: record.totalQuestions,
        outputText: record.outputText ?? record.problemText ?? null,
        recordingUrl: signals.recordingUrl,
        summaryEn: signals.summaryEn,
        mistakeCount: record._count.mistakes,
      };
    });

  const todayOutputs = effectiveOutputCount(toOutputSignals(todayRecords));
  const weekOutputs = effectiveOutputCount(toOutputSignals(weekRecords));

  // ───────── 三色与词汇 ─────────
  const colors: ColorDistributionDto = colorDistribution(
    lessons.map((lesson) => ({ color: lesson.currentColor as EgiuColor })),
  );
  const lessonTotal = lessons.length;
  const greenRatio = lessonTotal === 0 ? null : colors.GREEN / lessonTotal;

  const mastery: MasteryDistributionDto = {
    RECOGNIZE_ONLY: 0,
    COMPREHEND: 0,
    ACTIVE_USE: 0,
    total: vocabTotal,
    quizAccuracy: latestQuiz?.weightedAccuracy ?? null,
  };
  for (const row of vocabByMastery) {
    const level = row.mastery as MasteryLevel;
    if (level === 'RECOGNIZE_ONLY' || level === 'COMPREHEND' || level === 'ACTIVE_USE') {
      mastery[level] = row._count._all;
    }
  }

  // ───────── 待复习 ─────────
  const dueTodayItems = pendingReviews.filter((task) => task.dueDate === nowDate);
  const overdueItems = pendingReviews.filter((task) => diffDays(task.dueDate, nowDate) > 0);
  const next7Limit = addDays(nowDate, 7);
  const next7Items = pendingReviews.filter(
    (task) => task.dueDate > nowDate && task.dueDate <= next7Limit,
  );

  const reviewDebt: ReviewDebtDto = {
    dueToday: dueTodayItems.length,
    overdue: overdueItems.length,
    next7Days: next7Items.length,
    overdueItems: overdueItems.slice(0, 5).map((task) => ({
      id: task.id,
      label: task.targetLabel,
      intervalCode: task.intervalCode,
      overdueDays: overdueDays(task.dueDate, nowDate),
    })),
  };

  // ───────── 趋势 ─────────
  const trend7 = buildTrend(lastNDays(7, nowDate), minutesByDate);
  const trend30 = buildTrend(lastNDays(30, nowDate), minutesByDate);
  const dataDays = [...minutesByDate.values()].filter((minutes) => minutes > 0).length;

  // ───────── 薄弱点 ─────────
  const subjectTotals = mergeSampleTotals(
    windowRecords.map((record) => ({
      total: record.totalQuestions,
      correct: record.correctQuestions,
    })),
  );
  const skillAgg = new Map<string, { total: number; correct: number; planned: number; actual: number }>();
  for (const record of windowRecords) {
    const key = record.skill;
    const entry = skillAgg.get(key) ?? { total: 0, correct: 0, planned: 0, actual: 0 };
    entry.total += record.totalQuestions;
    entry.correct += Math.min(record.correctQuestions, record.totalQuestions);
    skillAgg.set(key, entry);
  }
  for (const task of windowTasks) {
    const entry = skillAgg.get(task.skill) ?? { total: 0, correct: 0, planned: 0, actual: 0 };
    entry.planned += task.plannedMinutes;
    entry.actual += task.actualMinutes;
    skillAgg.set(task.skill, entry);
  }

  const knowledgeAgg = new Map<
    string,
    { wrong: number; sampleTotal: number; categories: Map<string, number> }
  >();
  for (const mistake of windowMistakes) {
    const key = mistake.knowledgePoint;
    const entry =
      knowledgeAgg.get(key) ?? { wrong: 0, sampleTotal: 0, categories: new Map<string, number>() };
    entry.wrong += 1;
    entry.sampleTotal += Math.max(1, mistake.studyRecord?.totalQuestions ?? 1);
    entry.categories.set(
      mistake.errorCategory,
      (entry.categories.get(mistake.errorCategory) ?? 0) + 1,
    );
    knowledgeAgg.set(key, entry);
  }

  const reviewDebtByPoint = new Map<string, { total: number; overdue: number }>();
  for (const task of pendingReviews) {
    if (!task.knowledgePoint) continue;
    const entry = reviewDebtByPoint.get(task.knowledgePoint) ?? { total: 0, overdue: 0 };
    entry.total += 1;
    if (diffDays(task.dueDate, nowDate) > 0) entry.overdue += 1;
    reviewDebtByPoint.set(task.knowledgePoint, entry);
  }

  const redByPoint = new Map<string, number>();
  for (const lesson of lessons) {
    if (lesson.currentColor !== 'RED') continue;
    redByPoint.set(lesson.knowledgePoint, (redByPoint.get(lesson.knowledgePoint) ?? 0) + 1);
  }

  const candidates: WeaknessCandidate[] = [];

  for (const [skill, agg] of skillAgg.entries()) {
    if (agg.total === 0 && agg.planned === 0) continue;
    candidates.push({
      key: `SKILL:${skill}`,
      name: `${SKILL_LABEL_ZH[skill as SkillId] ?? skill}整体`,
      scope: 'SKILL',
      totalQuestions: agg.total,
      wrongQuestions: agg.total - agg.correct,
      subjectAcc: subjectTotals.accuracy,
      dimAcc: agg.total > 0 ? agg.correct / agg.total : null,
      plannedMinutes: agg.planned,
      actualMinutes: agg.actual,
      reviewTotal: 0,
      reviewOverdue: 0,
      unitTotal: 0,
      unitRed: 0,
    });
  }

  for (const [point, agg] of knowledgeAgg.entries()) {
    const debt = reviewDebtByPoint.get(point) ?? { total: 0, overdue: 0 };
    const dominant = [...agg.categories.entries()].sort((a, b) => b[1] - a[1])[0];
    candidates.push({
      key: `POINT:${point}`,
      name: point,
      scope: 'KNOWLEDGE',
      totalQuestions: agg.sampleTotal,
      wrongQuestions: agg.wrong,
      subjectAcc: subjectTotals.accuracy,
      dimAcc: Math.max(0, (agg.sampleTotal - agg.wrong) / agg.sampleTotal),
      plannedMinutes: 0,
      actualMinutes: 0,
      reviewTotal: debt.total,
      reviewOverdue: debt.overdue,
      unitTotal: 1,
      unitRed: redByPoint.get(point) ?? 0,
      mainErrorCategory: dominant?.[0],
    });
  }

  const weaknessResult = rankWeaknesses(candidates, {
    minQuestions: WEAKNESS_MIN_QUESTIONS,
    limit: WEAKNESS_TOP_N,
  });

  // ───────── 阶段门禁 ─────────
  let gate: GatePanelDto | null = null;
  if (stage) {
    const plannedDates = new Set(plannedDatesRaw.map((row) => row.planDate));
    /**
     * H4 的每日预算必须取**真实有效预算**（`getBudgetRange` 与
     * `getEffectiveBudget` 共用同一套解析优先级），不许在这里估一个近似值：
     * H4 是"相对预算"的达标率，分母本身错了整条指标就没有意义。
     */
    const gateDates = lastNDays(30, nowDate);
    const budgetByDate = await getBudgetRange(gateDates);
    const days = gateDates.map((date) => ({
      date,
      hasPlan: plannedDates.has(date),
      netMinutes: minutesByDate.get(date) ?? 0,
      // 拿不到预算 → NaN，由 `evaluateStageGate` 计入 missingBudgetDays，不静默按 0/60 处理
      budgetMinutes: budgetByDate.get(date)?.minutes ?? Number.NaN,
    }));

    const gateResult = evaluateStageGate({
      stageStart: stage.startedAt,
      stageEnd: stage.completedAt,
      today: nowDate,
      acceptance: acceptanceItems.map((item) => ({
        dimension: item.dimension,
        isRequired: item.isRequired,
        verdict: item.verdict as 'PENDING' | 'PASSED' | 'FAILED',
        myResult: item.myResult,
        evidence: item.evidence,
        judgedAt: item.judgedAt,
      })),
      reviewTasks: reviewTasksForGate.map((task) => ({
        intervalCode: task.intervalCode as IntervalCode,
        status: task.status as ReviewStatus,
        dueDate: task.dueDate,
        result: (task.result as ReviewResult | null) ?? null,
      })),
      days,
      lessons: lessons.map((lesson) => ({ currentColor: lesson.currentColor as EgiuColor })),
    });

    gate = {
      stageId: stage.id,
      stageCode: stage.code as StageCode,
      stageName: stage.nameZh,
      gate: gateResult,
    };
  }

  // ───────── 状态条 ─────────
  const statusStrip = stage
    ? {
        stageName: stage.nameZh,
        stageCode: stage.code as StageCode,
        startedAt: stage.startedAt,
        elapsedDays: stage.startedAt ? Math.max(0, diffDays(stage.startedAt, nowDate)) : 0,
        estDaysMin: stage.estDaysMin,
        estDaysMax: stage.estDaysMax,
        remainDays: stage.estDaysMax
          ? stage.estDaysMax - (stage.startedAt ? diffDays(stage.startedAt, nowDate) : 0)
          : null,
        overrunDays:
          stage.estDaysMax && stage.startedAt
            ? Math.max(0, diffDays(stage.startedAt, nowDate) - stage.estDaysMax)
            : 0,
        targetBand: profile.targetBandOverall,
      }
    : null;

  const plannedByDate = new Map<string, number>();
  for (const task of weekPlannedRows) {
    if (task.status === 'CANCELLED' || task.status === 'DEFERRED') continue;
    plannedByDate.set(task.planDate, (plannedByDate.get(task.planDate) ?? 0) + task.plannedMinutes);
  }
  const todayZone: DashboardZoneDto = {
    plannedMinutes: plannedByDate.get(nowDate) ?? 0,
    netMinutes: todayNet,
    effectiveOutputs: todayOutputs,
    greenRatio,
  };
  const weekZone: DashboardZoneDto = {
    plannedMinutes: listDateRange(week.weekStart, week.weekEnd).reduce(
      (sum, date) => sum + (plannedByDate.get(date) ?? 0),
      0,
    ),
    netMinutes: weekNet,
    effectiveOutputs: weekOutputs,
    greenRatio,
  };

  return {
    statusStrip,
    zones: { today: todayZone, week: weekZone },
    today: {
      planDate: nowDate,
      completionByTime: todayCompletion.byTime,
      completionByCount: todayCompletion.byCount,
      doneTasks,
      totalTasks: todayTasks.length,
      remainingMinutes,
      nextTask: nextTask
        ? {
            id: nextTask.id,
            label: MODULE_META[nextTask.module as ModuleId]?.labelZh ?? nextTask.module,
            plannedMinutes: nextTask.plannedMinutes,
            expectedOutput: expectedOutputOfTaskDecision(nextDecision),
            estimate: estimateOfTaskDecision(nextDecision),
          }
        : null,
    },
    week: {
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      netMinutes: weekNet,
      completionByTime: weekCompletion.byTime,
      prevNetMinutes,
      netDelta: weekNet - prevNetMinutes,
    },
    skillInvestment: investment,
    allocation: {
      minutes: primaryMinutes,
      // 阶段无 profileCode（历史数据）时按 ACTIVE 阶段推导；仍为空则不给建议值
      target: stage?.profileCode
        ? defaultAllocationFor(stage.profileCode as StageProfileCode)
        : null,
      profileCode: (stage?.profileCode as StageProfileCode | null) ?? null,
    },
    grammarVocab: {
      colors,
      redUnhandled: colors.RED,
      vocabTotal,
      vocabNewThisWeek,
      mastery,
    },
    reviewDebt,
    trend7,
    trend30,
    weakness: {
      ranked: weaknessResult.ranked,
      insufficient: weaknessResult.insufficient,
      dataDays,
    },
    gate,
    dataDays,
  };
}

/** 今天是否是周复盘日（设置里的 weeklyReviewDow）。 */
export async function isWeeklyReviewDay(nowDateParam?: string): Promise<boolean> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const profile = await getProfile();
  return dayOfWeek(nowDate) === profile.weeklyReviewDow;
}
