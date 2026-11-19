/**
 * 分析看板数据装配（T30 / T31 / T32）。
 *
 * 十张图的数据全部在这里算好，组件只负责画。口径复用既有域函数：
 * - 分钟数只从 `StudySessionDaySplit` 求和（已含跨零点拆分）；
 * - 分钟分桶只用 `skillMinutes`（泛听泛读只进 EXTENSIVE）；
 * - 正确率只用 `weightedAccuracy`（先合并分子分母再相除）；
 * - 完成率只用 `completionRate`（按时长加权）。
 */

import type { Prisma } from '@prisma/client';
import {
  ANALYTICS_WEEKS,
  ANALYTICS_WINDOW_DAYS,
  CHART_MIN_POINTS,
  ERROR_CATEGORIES,
  ERROR_CATEGORY_LABEL_ZH,
  EGIU_COLOR_LABEL_ZH,
  EGIU_COLORS,
  MASTERY_LABEL_ZH,
  MASTERY_LEVELS,
  SKILL_BUCKET_LABEL_ZH,
  SKILL_BUCKET_ORDER,
  SKILL_IDS,
  SKILL_LABEL_ZH,
} from '@/lib/constants';
import {
  addDays,
  endOfBusinessDay,
  isoWeek as isoWeekOf,
  listDateRange,
  startOfIsoWeek,
  toUtcInstant,
  today,
} from '@/lib/date';
import { weightedAccuracy } from '@/lib/domain/accuracy';
import { completionRate } from '@/lib/domain/completion';
import { skillMinutes } from '@/lib/domain/duration';
import { prisma } from '@/lib/prisma';
import { getBudgetRange } from './budget';
import type {
  AnalyticsDto,
  EgiuColor,
  ErrorCategory,
  GlobalFilterDto,
  SeriesPointDto,
  SkillBucket,
  SkillId,
  TaskStatus,
} from '@/lib/types';

/** 生成 `[{label, value}]`，并把「无数据的点」置为 null（折线断开，不补 0）。 */
function toPoints(entries: { label: string; value: number | null }[]): SeriesPointDto[] {
  return entries.map((entry) => ({ label: entry.label, value: entry.value }));
}

/** 序列是否有至少 N 个有效点（否则页面走空态）。 */
export function hasEnoughPoints(
  points: SeriesPointDto[],
  min: number = CHART_MIN_POINTS,
): boolean {
  return points.filter((point) => point.value !== null).length >= min;
}

/** 时间窗内所有 ISO 周（周一列表）。 */
function weekBuckets(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = startOfIsoWeek(from);
  const last = startOfIsoWeek(to);
  let guard = 0;
  while (cursor <= last && guard < ANALYTICS_WEEKS * 4) {
    out.push(cursor);
    cursor = addDays(cursor, 7);
    guard += 1;
  }
  return out;
}

/**
 * 装配十张图的数据。
 *
 * @param filter 已解析的全局筛选（URL searchParams → GlobalFilterDto）
 */
export async function getAnalytics(filter: GlobalFilterDto): Promise<AnalyticsDto> {
  const { from, to } = filter;
  const startInstant = toUtcInstant(from);
  const endInstant = endOfBusinessDay(to);

  const taskWhere: Prisma.PlanTaskWhereInput = {};
  if (filter.stageId) taskWhere.stageId = filter.stageId;
  if (filter.skill) taskWhere.skill = filter.skill;
  if (filter.resourceId) taskWhere.resourceId = filter.resourceId;
  const hasTaskFilter = Object.keys(taskWhere).length > 0;

  /** 计时段过滤：日期窗 + （可选）经 session→task 下推的阶段/科目/资源筛选。 */
  const splitWhere: Prisma.StudySessionDaySplitWhereInput = { date: { gte: from, lte: to } };
  if (hasTaskFilter) splitWhere.session = { task: taskWhere };

  const [
    splits,
    tasks,
    stages,
    lessons,
    egiuReviews,
    vocabWords,
    mistakeGroups,
    recordGroups,
  ] = await Promise.all([
    prisma.studySessionDaySplit.findMany({
      where: splitWhere,
      select: {
        date: true,
        minutes: true,
        session: { select: { task: { select: { skill: true, stageId: true } } } },
      },
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: from, lte: to }, ...taskWhere },
      select: {
        planDate: true,
        plannedMinutes: true,
        actualMinutes: true,
        status: true,
        movedFromDate: true,
        movedToDate: true,
      },
    }),
    prisma.stage.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, code: true } }),
    prisma.egiuLesson.findMany({ where: { archivedAt: null }, select: { currentColor: true } }),
    prisma.egiuReview.findMany({
      where: { reviewDate: { gte: from, lte: to } },
      select: { reviewDate: true, correctQuestions: true, totalQuestions: true },
    }),
    prisma.vocabWord.findMany({
      where: { archivedAt: null, learnedDate: { lte: to } },
      select: { learnedDate: true },
    }),
    prisma.mistake.groupBy({
      by: ['errorCategory'],
      where: { archivedAt: null, createdAt: { gte: startInstant, lte: endInstant } },
      _count: { _all: true },
    }),
    prisma.studyRecord.groupBy({
      by: ['skill'],
      where: { archivedAt: null, recordDate: { gte: from, lte: to } },
      _count: { _all: true },
    }),
  ]);

  // ── 逐日 / 逐周净时长，以及 8 桶分钟数 ──
  const dates = listDateRange(from, to);
  const dailyMap = new Map<string, number>();
  const skillRows: { skill: SkillId; minutes: number }[] = [];
  const stageMinutes = new Map<string, number>();

  for (const row of splits) {
    dailyMap.set(row.date, (dailyMap.get(row.date) ?? 0) + row.minutes);
    const skill = row.session?.task?.skill;
    const stageId = row.session?.task?.stageId;
    if (typeof skill === 'string') skillRows.push({ skill: skill as SkillId, minutes: row.minutes });
    if (typeof stageId === 'string') {
      stageMinutes.set(stageId, (stageMinutes.get(stageId) ?? 0) + row.minutes);
    }
  }

  const dailyMinutes: SeriesPointDto[] = toPoints(
    dates.map((date) => ({
      label: date.slice(5),
      value: dailyMap.has(date) ? (dailyMap.get(date) as number) : null,
    })),
  );

  // ── 每周净时长 + 每周完成率（先合并分子分母） ──
  const weeks = weekBuckets(from, to);
  const weeklyMinutes: SeriesPointDto[] = [];
  const weeklyCompletion: SeriesPointDto[] = [];
  for (const weekStart of weeks) {
    const weekEnd = addDays(weekStart, 6);
    const minutes = dates
      .filter((date) => date >= weekStart && date <= weekEnd)
      .reduce((total, date) => total + (dailyMap.get(date) ?? 0), 0);
    const iso = isoWeekOf(weekStart);
    const label = `W${iso.isoWeek}`;
    weeklyMinutes.push({ label, value: minutes > 0 ? minutes : null, hint: `${weekStart} ~ ${weekEnd}` });

    const weekTasks = tasks.filter((task) => task.planDate >= weekStart && task.planDate <= weekEnd);
    const rate = completionRate(
      weekTasks.map((task) => ({
        plannedMinutes: task.plannedMinutes,
        actualMinutes: task.actualMinutes,
        status: task.status as TaskStatus,
        movedFromDate: task.movedFromDate,
        movedToDate: task.movedToDate,
      })),
    ).byTime;
    weeklyCompletion.push({
      label,
      value: rate === null ? null : Math.round(rate * 1000) / 10,
      hint: `${weekStart} ~ ${weekEnd}`,
    });
  }

  // ── 四科（含泛练与语言知识）投入分布 ──
  // 注意：`skillMinutes` 的结果里还有 META（复盘与计划）桶，但这里**刻意不画它** ——
  // 四科分布只描述听说读写 + 泛练 + 语言知识，复盘时间计入会把四科占比压小（缺陷 D7）。
  // `SKILL_BUCKET_ORDER` 本身就是不含 META 的展示顺序，故此处无需额外过滤。
  const buckets = skillMinutes(skillRows);
  const skillDistribution: SeriesPointDto[] = SKILL_BUCKET_ORDER.map((bucket: SkillBucket) => ({
    label: SKILL_BUCKET_LABEL_ZH[bucket],
    value: buckets[bucket],
  }));

  // ── 阶段投入 ──
  const stageInvestment: SeriesPointDto[] = stages.map((stage) => ({
    label: stage.code,
    value: stageMinutes.get(stage.id) ?? 0,
  }));

  // ── EGIU 三色分布 ──
  const colorCounts: Record<EgiuColor, number> = { PENDING: 0, GREEN: 0, YELLOW: 0, RED: 0 };
  for (const lesson of lessons) {
    const color = lesson.currentColor as EgiuColor;
    if (color in colorCounts) colorCounts[color] += 1;
  }
  const egiuColors: SeriesPointDto[] = EGIU_COLORS.filter((color) => color !== 'PENDING').map(
    (color) => ({ label: EGIU_COLOR_LABEL_ZH[color], value: colorCounts[color] }),
  );

  // ── 语法正确率趋势（按周加权：Σcorrect / Σtotal） ──
  const grammarAccuracy: SeriesPointDto[] = weeks.map((weekStart) => {
    const weekEnd = addDays(weekStart, 6);
    const samples = egiuReviews
      .filter((review) => review.reviewDate >= weekStart && review.reviewDate <= weekEnd)
      .map((review) => ({ total: review.totalQuestions, correct: review.correctQuestions }));
    const accuracy = weightedAccuracy(samples);
    const iso = isoWeekOf(weekStart);
    return {
      label: `W${iso.isoWeek}`,
      value: accuracy === null ? null : Math.round(accuracy * 1000) / 10,
      hint: `${weekStart} ~ ${weekEnd}`,
    };
  });

  // ── 词汇积累（累计条数，按周） ──
  const vocabGrowth: SeriesPointDto[] = weeks.map((weekStart) => {
    const weekEnd = addDays(weekStart, 6);
    const cumulative = vocabWords.filter((word) => word.learnedDate <= weekEnd).length;
    const iso = isoWeekOf(weekStart);
    return {
      label: `W${iso.isoWeek}`,
      value: cumulative,
      hint: `截至 ${weekEnd}`,
    };
  });

  // ── 错题类型 ──
  const mistakeCountMap = new Map<string, number>();
  for (const group of mistakeGroups) mistakeCountMap.set(group.errorCategory, group._count._all);
  const mistakeTypes: SeriesPointDto[] = ERROR_CATEGORIES.map((category: ErrorCategory) => ({
    label: ERROR_CATEGORY_LABEL_ZH[category],
    value: mistakeCountMap.get(category) ?? 0,
  }));

  // ── 科目记录历史（记录条数） ──
  const recordCountMap = new Map<string, number>();
  for (const group of recordGroups) recordCountMap.set(group.skill, group._count._all);
  const skillHistory: SeriesPointDto[] = SKILL_IDS.map((skill) => ({
    label: SKILL_LABEL_ZH[skill],
    value: recordCountMap.get(skill) ?? 0,
  }));

  return {
    windowDays: dates.length,
    dailyMinutes,
    weeklyMinutes,
    skillDistribution,
    stageInvestment,
    egiuColors,
    grammarAccuracy,
    vocabGrowth,
    weeklyCompletion,
    mistakeTypes,
    skillHistory,
  };
}

/** 时间窗文案（页面副标题用）。 */
export function describeWindow(filter: GlobalFilterDto): string {
  return `${filter.from} ~ ${filter.to}`;
}

/** 词汇三档（供分析页副卡使用，标签来自常量，避免页面自己写死文案）。 */
export function masteryLevelCounts(): { level: string; label: string }[] {
  return MASTERY_LEVELS.map((level) => ({ level, label: MASTERY_LABEL_ZH[level] }));
}

/** 分析窗口内「非休息日有效预算」的日均（图表页「目标」提示用）。 */
export async function getDailyMinutesBudget(): Promise<number> {
  const todayStr = today();
  const from = addDays(todayStr, -(ANALYTICS_WINDOW_DAYS - 1));
  const dates = listDateRange(from, todayStr);
  const budgets = await getBudgetRange(dates);
  const usable = [...budgets.values()].filter((b) => !b.isRestDay && b.minutes > 0);
  if (usable.length === 0) return 0;
  return Math.round(usable.reduce((sum, b) => sum + b.minutes, 0) / usable.length);
}
