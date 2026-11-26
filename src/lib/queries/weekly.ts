/**
 * 周复盘数据装配（T29）。
 *
 * 只读：把数据库里的原始记录聚合成 `WeeklyRawInput`，再交给
 * `domain/weekly.ts` 产出 13 项指标。页面拿到的是「已算好的字符串」，
 * 不做任何二次计算。
 */

import {
  ERROR_CATEGORY_LABEL_ZH,
  TASK_STATUSES_EXCLUDED_FROM_RATE,
  WEEKLY_TOP3_COUNT,
} from '@/lib/constants';
import { getBusinessTimezone, resolveBusinessDate } from '@/lib/businessTime';
import {
  addDays,
  diffDays,
  endOfBusinessDay,
  isoWeek as isoWeekOf,
  listDateRange,
  startOfIsoWeek,
  today,
  toUtcInstant,
} from '@/lib/date';
import { completionRate } from '@/lib/domain/completion';
import { skillMinutes } from '@/lib/domain/duration';
import { trackStats } from '@/lib/domain/tracks';
import {
  buildWeeklyMetrics,
  isPartialWeek,
  mergeWeeklyMetrics,
  normalizeTop3,
  type StoredWeeklyMetrics,
  type WeeklyRawInput,
} from '@/lib/domain/weekly';
import {
  buildWeeklyDelta,
  type WeeklyDeltaResult,
  type WeeklyDeltaSnapshot,
} from '@/lib/domain/weeklyDelta';
import { parseJson } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { getBudgetRange } from './budget';
import type {
  ErrorCategory,
  MasteryLevel,
  SkillId,
  TaskStatus,
  WeeklyBudgetDto,
  WeeklyReviewDto,
  WeeklyTop3Dto,
  WeeklyWeekOptionDto,
} from '@/lib/types';

/** ISO 周 → 该周的周一。反向映射，供 URL 上的 `year/week` 使用。 */
export function isoWeekStart(isoYear: number, week: number): string {
  const jan4 = `${isoYear}-01-04`;
  const monday = startOfIsoWeek(jan4);
  return addDays(monday, (Math.max(1, week) - 1) * 7);
}

/** 空三档。 */
function emptyMastery(): Record<MasteryLevel, number> {
  return { RECOGNIZE_ONLY: 0, COMPREHEND: 0, ACTIVE_USE: 0 };
}

/**
 * 某一周的「三轨道净时长」统计（v2.0 P2）。
 *
 * 数据源与净时长唯一来源一致：`StudySessionDaySplit.minutes` join `StudySession.track`。
 * 每条 split 只落一个 session、每个 session 只落一个 track，因此不会重复计时。
 * 复用 `domain/tracks.ts` 的 `trackStats`，保证「一条时长只计一次」的口径唯一。
 */
export async function getWeeklyTrackStats(isoYear: number, weekNo: number) {
  const weekStart = isoWeekStart(isoYear, weekNo);
  const weekEnd = addDays(weekStart, 6);

  const rows = await prisma.studySessionDaySplit.findMany({
    where: { date: { gte: weekStart, lte: weekEnd } },
    select: { minutes: true, session: { select: { track: true } } },
  });

  return trackStats(
    rows.map((row) => ({ track: row.session.track, minutes: row.minutes })),
  );
}

/** 计算某一周的原始输入。 */
export async function getWeeklyRawInput(
  weekStart: string,
  weekEnd: string,
  nowDateParam?: string,
): Promise<WeeklyRawInput> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const timeZone = await getBusinessTimezone();
  const prevStart = addDays(weekStart, -7);
  const prevEnd = addDays(weekEnd, -7);
  const startInstant = toUtcInstant(weekStart, '00:00', timeZone);
  const endInstant = endOfBusinessDay(weekEnd, timeZone);
  const prevStartInstant = toUtcInstant(prevStart, '00:00', timeZone);
  const prevEndInstant = endOfBusinessDay(prevEnd, timeZone);

  const [
    splitRows,
    prevSplitRows,
    tasks,
    reviews,
    prevReviews,
    masteredLessons,
    mistakesAdded,
    mistakesMastered,
    mistakeGroups,
    reviewDone,
    reviewFailed,
    reviewOverdue,
    vocabNew,
    vocabReviews,
    quiz,
    masteryGroups,
  ] = await Promise.all([
    prisma.studySessionDaySplit.findMany({
      where: { date: { gte: weekStart, lte: weekEnd } },
      select: {
        date: true,
        minutes: true,
        // v2.0：8 桶统计需要**模块粒度**（区分泛听/精听、词汇/语法），
        // 而 `session.skill` 只有四技能粒度。两者口径不同，不能互替：
        //   模块粒度 → task.skill（无 task 的媒介学习 session 归 MEDIATED 桶）
        //   四技能   → session.skill（用于配比分母）
        // 旧写法只读 `session.task.skill` 且不带兜底，taskId 可空后会整段漏算（D21）。
        session: {
          select: { skill: true, track: true, task: { select: { skill: true } } },
        },
      },
    }),
    prisma.studySessionDaySplit.groupBy({
      by: ['date'],
      where: { date: { gte: prevStart, lte: prevEnd } },
      _sum: { minutes: true },
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: weekStart, lte: weekEnd } },
      select: {
        plannedMinutes: true,
        actualMinutes: true,
        status: true,
        movedFromDate: true,
        movedToDate: true,
      },
    }),
    prisma.egiuReview.findMany({
      where: { reviewDate: { gte: weekStart, lte: weekEnd } },
      select: { judgedColor: true },
    }),
    prisma.egiuReview.findMany({
      where: { reviewDate: { gte: prevStart, lte: prevEnd } },
      select: { judgedColor: true },
    }),
    prisma.egiuLesson.count({
      where: { masteredAt: { gte: startInstant, lt: endInstant } },
    }),
    prisma.mistake.count({ where: { createdAt: { gte: startInstant, lt: endInstant } } }),
    prisma.mistake.count({
      where: { isMastered: true, updatedAt: { gte: startInstant, lt: endInstant } },
    }),
    prisma.mistake.groupBy({
      by: ['errorCategory'],
      where: { createdAt: { gte: startInstant, lt: endInstant } },
      _count: { _all: true },
    }),
    prisma.reviewTask.count({
      where: { dueDate: { gte: weekStart, lte: weekEnd }, status: 'DONE', result: 'PASS' },
    }),
    prisma.reviewTask.count({
      where: { dueDate: { gte: weekStart, lte: weekEnd }, status: 'DONE', result: 'FAIL' },
    }),
    prisma.reviewTask.count({
      where: { status: 'PENDING', dueDate: { lt: nowDate } },
    }),
    prisma.vocabWord.count({ where: { archivedAt: null, learnedDate: { gte: weekStart, lte: weekEnd } } }),
    prisma.vocabWord.count({
      where: { archivedAt: null, lastReviewAt: { gte: weekStart, lte: weekEnd } },
    }),
    prisma.vocabQuiz.findFirst({
      where: { quizDate: { gte: weekStart, lte: weekEnd } },
      orderBy: [{ quizDate: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.vocabWord.groupBy({
      by: ['mastery'],
      where: { archivedAt: null, learnedDate: { lte: weekEnd } },
      _count: { _all: true },
    }),
  ]);

  // 逐日净时长 + 8 桶分钟数（同一份 join 结果，避免两次口径不一致）
  const dailyMap = new Map<string, number>();
  const bucketRows: { skill: SkillId; minutes: number }[] = [];
  for (const row of splitRows) {
    dailyMap.set(row.date, (dailyMap.get(row.date) ?? 0) + row.minutes);
    // 模块粒度优先取 task.skill；无 task 的 session（媒介学习）落到 MEDIATED 桶，
    // 绝不丢弃 —— 丢弃会让「本周净时长」与「分桶之和」静默不相等。
    const taskSkill = row.session?.task?.skill;
    const skill =
      typeof taskSkill === 'string'
        ? (taskSkill as SkillId)
        : row.session?.track === 'ENGLISH_MEDIATED_LEARNING'
          ? ('MEDIATED' as SkillId)
          : null;
    if (skill) {
      bucketRows.push({ skill, minutes: row.minutes });
    }
  }

  const prevNetMinutes = prevSplitRows.reduce((total, row) => total + (row._sum.minutes ?? 0), 0);
  const netMinutes = splitRows.reduce((total, row) => total + row.minutes, 0);
  const dataDays = [...dailyMap.values()].filter((minutes) => minutes > 0).length;

  const colorCounts = (rows: { judgedColor: string }[]) => {
    const out = { green: 0, yellow: 0, red: 0, pending: 0 };
    for (const row of rows) {
      if (row.judgedColor === 'GREEN') out.green += 1;
      else if (row.judgedColor === 'YELLOW') out.yellow += 1;
      else if (row.judgedColor === 'RED') out.red += 1;
      else out.pending += 1;
    }
    return out;
  };

  const topCategory =
    mistakeGroups.length === 0
      ? null
      : [...mistakeGroups].sort((a, b) => b._count._all - a._count._all)[0].errorCategory;

  const mastery = emptyMastery();
  for (const group of masteryGroups) {
    const level = group.mastery as MasteryLevel;
    if (level in mastery) mastery[level] = group._count._all;
  }

  const daysElapsed = Math.min(7, Math.max(1, diffDays(weekStart, nowDate) + 1));

  return {
    weekStart,
    weekEnd,
    netMinutes,
    prevNetMinutes,
    dailyMinutes: listDateRange(weekStart, weekEnd).map((date) => ({
      date,
      minutes: dailyMap.get(date) ?? 0,
    })),
    completionByTime: completionRate(
      tasks.map((task) => ({
        plannedMinutes: task.plannedMinutes,
        actualMinutes: task.actualMinutes,
        status: task.status as TaskStatus,
        movedFromDate: task.movedFromDate,
        movedToDate: task.movedToDate,
      })),
    ).byTime,
    skillMinutes: skillMinutes(bucketRows),
    egiu: colorCounts(reviews),
    prevEgiu: colorCounts(prevReviews),
    review: {
      done: reviewDone + reviewFailed,
      failed: reviewFailed,
      overdue: reviewOverdue,
      masteredLessons,
    },
    mistakes: {
      added: mistakesAdded,
      mastered: mistakesMastered,
      topCategoryLabel: topCategory
        ? (ERROR_CATEGORY_LABEL_ZH[topCategory as ErrorCategory] ?? topCategory)
        : null,
    },
    vocab: {
      newCount: vocabNew,
      reviewCount: vocabReviews,
      quizAccuracy: quiz?.weightedAccuracy ?? null,
    },
    mastery,
    dataDays,
    daysElapsed,
  };
}

/** 指标 JSON 反序列化。 */
function parseStoredMetrics(raw: string | null): StoredWeeklyMetrics | null {
  const parsed = parseJson<Record<string, { auto?: string; override?: string | null; overriddenAt?: string | null }>>(
    raw,
    {},
  );
  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;
  const out: StoredWeeklyMetrics = {};
  for (const [key, value] of entries) {
    out[key as keyof StoredWeeklyMetrics] = {
      auto: typeof value.auto === 'string' ? value.auto : '',
      override: typeof value.override === 'string' ? value.override : null,
      overriddenAt: typeof value.overriddenAt === 'string' ? value.overriddenAt : null,
    };
  }
  return out;
}

/** Top3 JSON 反序列化（历史数据可能不足 3 项，用空项补齐）。 */
function parseStoredTop3(raw: string | null): WeeklyTop3Dto[] {
  const parsed = parseJson<unknown>(raw, []);
  const list = Array.isArray(parsed) ? parsed : [];
  const items: Partial<WeeklyTop3Dto>[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    items.push({
      name: typeof record.name === 'string' ? record.name : '',
      score: typeof record.score === 'number' ? record.score : 0,
      evidence: typeof record.evidence === 'string' ? record.evidence : '',
      manual: record.manual === true,
    });
  }
  const normalized = normalizeTop3(items);
  while (normalized.length < WEEKLY_TOP3_COUNT) {
    normalized.push({ name: '', score: 0, evidence: '', manual: true });
  }
  return normalized;
}

/**
 * 取某一周的复盘（有存档则合并存档的覆盖值，没有则返回实时计算值）。
 *
 * @param isoYear ISO 周年
 * @param weekNo ISO 周序号
 */
export async function getWeeklyReview(
  isoYear: number,
  weekNo: number,
  nowDateParam?: string,
): Promise<WeeklyReviewDto> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const weekStart = isoWeekStart(isoYear, weekNo);
  const weekEnd = addDays(weekStart, 6);

  const [raw, saved] = await Promise.all([
    getWeeklyRawInput(weekStart, weekEnd, nowDate),
    prisma.weeklyReview.findUnique({ where: { isoYear_isoWeek: { isoYear, isoWeek: weekNo } } }),
  ]);

  const drafts = buildWeeklyMetrics(raw);
  const metrics = mergeWeeklyMetrics(drafts, parseStoredMetrics(saved?.metrics ?? null));
  const isPartial = saved?.isPartial ?? isPartialWeek(raw.dataDays, raw.daysElapsed);

  return {
    id: saved?.id ?? null,
    isoYear,
    isoWeek: weekNo,
    weekStart,
    weekEnd,
    isPartial,
    metrics,
    top3: saved ? parseStoredTop3(saved.top3Weaknesses) : [],
    reviewNote: saved?.reviewNote ?? null,
    exportedAt: saved?.exportedAt ? saved.exportedAt.toISOString() : null,
    savedAt: saved ? saved.updatedAt.toISOString() : null,
  };
}

/** 最近 N 周（含本周）的下拉选项。 */
export async function listWeekOptions(count = 8, nowDateParam?: string): Promise<WeeklyWeekOptionDto[]> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const current = isoWeekOf(nowDate);
  const existing = await prisma.weeklyReview.findMany({ select: { isoYear: true, isoWeek: true } });
  const savedSet = new Set(existing.map((row) => `${row.isoYear}-${row.isoWeek}`));

  const options: WeeklyWeekOptionDto[] = [];
  let cursor = startOfIsoWeek(nowDate);
  for (let i = 0; i < count; i += 1) {
    const iso = isoWeekOf(cursor);
    options.push({
      isoYear: iso.isoYear,
      isoWeek: iso.isoWeek,
      weekStart: cursor,
      weekEnd: addDays(cursor, 6),
      label: `${iso.isoYear}-W${String(iso.isoWeek).padStart(2, '0')}`,
      saved: savedSet.has(`${iso.isoYear}-${iso.isoWeek}`),
    });
    cursor = addDays(cursor, -7);
  }
  return options;
}

/** 当前 ISO 周（页面默认值）。 */
export function currentIsoWeek(nowDate: string = today()): { isoYear: number; isoWeek: number } {
  return isoWeekOf(nowDate);
}

/**
 * 周报「预算 vs 实际」（v2.1）。
 *
 * 预算解析复用 `getBudgetRange`，不在这里另写一套优先级 ——
 * 否则计划页显示 90、周报显示 240 这类口径分裂会再次出现。
 * 实际净时长仍只从 `StudySessionDaySplit` 求和。
 */
export async function getWeeklyBudget(isoYear: number, weekNo: number): Promise<WeeklyBudgetDto> {
  const weekStart = isoWeekStart(isoYear, weekNo);
  const weekEnd = addDays(weekStart, 6);
  const dates = listDateRange(weekStart, weekEnd);

  const [budgets, splitRows, taskRows, versions, target] = await Promise.all([
    getBudgetRange(dates),
    prisma.studySessionDaySplit.groupBy({
      by: ['date'],
      where: { date: { gte: weekStart, lte: weekEnd } },
      _sum: { minutes: true },
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: weekStart, lte: weekEnd } },
      select: { planDate: true, plannedMinutes: true, status: true },
    }),
    prisma.planVersion.findMany({
      where: { planDate: { gte: weekStart, lte: weekEnd } },
      orderBy: [{ planDate: 'asc' }, { version: 'asc' }],
      select: {
        planDate: true,
        version: true,
        changeSource: true,
        budgetMinutes: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.weeklyTarget.findUnique({ where: { weekStart } }),
  ]);

  const netByDate = new Map<string, number>();
  for (const row of splitRows) netByDate.set(row.date, row._sum.minutes ?? 0);

  const plannedByDate = new Map<string, number>();
  for (const row of taskRows) {
    // 与计划页同口径：取消/延期的任务已移出当日，不计入计划分钟
    if (TASK_STATUSES_EXCLUDED_FROM_RATE.includes(row.status as TaskStatus)) continue;
    plannedByDate.set(row.planDate, (plannedByDate.get(row.planDate) ?? 0) + row.plannedMinutes);
  }

  const days = dates.map((date) => {
    const budget = budgets.get(date);
    return {
      date,
      budgetMinutes: budget?.minutes ?? 0,
      isRestDay: budget?.isRestDay ?? false,
      source: budget?.source ?? 'DEFAULT_SUGGESTION',
      isSuggestion: budget?.isSuggestion ?? true,
      netMinutes: netByDate.get(date) ?? 0,
      plannedMinutes: plannedByDate.get(date) ?? 0,
    };
  });

  const budgetTotalMinutes = days.reduce(
    (sum, day) => sum + (day.isRestDay ? 0 : day.budgetMinutes),
    0,
  );
  const netTotalMinutes = days.reduce((sum, day) => sum + day.netMinutes, 0);

  return {
    days,
    budgetTotalMinutes,
    netTotalMinutes,
    budgetedDays: days.filter((day) => !day.isRestDay && day.budgetMinutes > 0).length,
    restDays: days.filter((day) => day.isRestDay).length,
    // 每天必然有一条 GENERATE 版本；超过 1 条的部分才算「中途重排」
    replanCount: versions.filter((row) => row.changeSource !== 'GENERATE').length,
    versions: versions
      .filter((row) => row.changeSource !== 'GENERATE')
      .map((row) => ({
        version: row.version,
        changeSource: row.changeSource,
        budgetMinutes: row.budgetMinutes,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
    target: target
      ? { targetMinutes: target.targetMinutes, status: target.status, source: target.source }
      : null,
  };
}

// ───────────────────────── v2.7 T13 周复盘变化（AC-12 数据侧） ─────────────────────────

export interface WeeklyDeltaDto {
  isoYear: number;
  isoWeek: number;
  weekStart: string;
  weekEnd: string;
  /** 本周对比的上一周周一；无上周数据也返回日期，仅用于展示。 */
  previousWeekStart: string;
  delta: WeeklyDeltaResult;
}

/** 三色判定 + 复测 → 一周指标快照；口径与周复盘 13 项指标同源（同一份 raw）。 */
function snapshotFromRaw(raw: WeeklyRawInput, uncertaintyCount: number): WeeklyDeltaSnapshot {
  const judged = raw.egiu.green + raw.egiu.yellow + raw.egiu.red;
  const retestSample = raw.review.done + raw.review.failed;
  return {
    weekStart: raw.weekStart,
    activeDays: raw.dataDays,
    accuracy: judged > 0 ? raw.egiu.green / judged : null,
    accuracySample: judged,
    retestKeepRate: retestSample > 0 ? raw.review.done / retestSample : null,
    retestSample,
    evidenceCount: judged + retestSample,
    uncertaintyCount,
  };
}

/**
 * 「截至某周末」的待确认维度数（UNCERTAINTY + UNKNOWN）。
 *
 * 用 `asOfDate <= weekEnd` 的最近一次诊断快照：周中做过诊断也算「截至周末已知」，
 * 绝不为了凑对比而在周复盘里现场重算缺口（G-7：解释/诊断不在页面层重算）。
 */
async function uncertaintyCountAsOf(weekEnd: string): Promise<number> {
  const snapshot = await prisma.planningSnapshot.findFirst({
    where: { asOfDate: { lte: weekEnd } },
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  if (!snapshot) return 0;
  return prisma.skillGap.count({
    where: { snapshotId: snapshot.id, kind: { in: ['UNCERTAINTY', 'UNKNOWN'] } },
  });
}

/**
 * 周复盘变化：当前周、上周、上上周各取一份指标快照，交给
 * `buildWeeklyDelta()` 产出改善/未解决/需诊断三类结论。
 *
 * 取三周是因为「连续 2 周 ≥15%」需要两次相邻比较；缺任何一周都由纯函数
 * 自己降级（无基线 / 只能按单周+样本门槛判定），不在这里补假数据。
 */
export async function getWeeklyDelta(
  isoYear: number,
  weekNo: number,
  nowDateParam?: string,
): Promise<WeeklyDeltaDto> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const weekStart = isoWeekStart(isoYear, weekNo);
  const weekEnd = addDays(weekStart, 6);
  const previousStart = addDays(weekStart, -7);
  const priorStart = addDays(weekStart, -14);

  const [currentRaw, previousRaw, priorRaw] = await Promise.all([
    getWeeklyRawInput(weekStart, weekEnd, nowDate),
    getWeeklyRawInput(previousStart, addDays(previousStart, 6), nowDate),
    getWeeklyRawInput(priorStart, addDays(priorStart, 6), nowDate),
  ]);
  const [currentUncertainty, previousUncertainty, priorUncertainty] = await Promise.all([
    uncertaintyCountAsOf(weekEnd),
    uncertaintyCountAsOf(addDays(previousStart, 6)),
    uncertaintyCountAsOf(addDays(priorStart, 6)),
  ]);

  const delta = buildWeeklyDelta({
    current: snapshotFromRaw(currentRaw, currentUncertainty),
    previous: snapshotFromRaw(previousRaw, previousUncertainty),
    prior: snapshotFromRaw(priorRaw, priorUncertainty),
  });

  return {
    isoYear,
    isoWeek: weekNo,
    weekStart,
    weekEnd,
    previousWeekStart: previousStart,
    delta,
  };
}
