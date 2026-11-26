/**
 * EGIU 单元与复测的只读查询（T21 / T23）。
 *
 * 只读：三色、分支、理由全部来自已落库的 `EgiuReview` / `EgiuLesson`，
 * 页面**不允许**重算颜色。
 */

import type { Prisma } from '@prisma/client';
import {
  EGIU_COLOR_LABEL_ZH,
  JUDGE_BRANCH_LABEL_ZH,
  MASTERY_GREEN_STREAK,
  MASTERY_MIN_GAP_DAYS,
  REVIEW_STAGE_LABEL_ZH,
  STAGE_META,
} from '@/lib/constants';
import { accuracyOf } from '@/lib/domain/accuracy';
import { businessToday, getBusinessTimezone, resolveBusinessDate } from '@/lib/businessTime';
import { startOfIsoWeek, toBusinessDate } from '@/lib/date';
import { parseObject } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { listUpcomingReviews } from '@/lib/queries/reviews';
import type {
  EgiuColor,
  EgiuErrorBreakdownDto,
  EgiuLessonDetailDto,
  EgiuLessonRowDto,
  EgiuMasteryChangeDto,
  EgiuReviewRowDto,
  JudgeBranch,
  ReviewStageCode,
  StageCode,
} from '@/lib/types';

/** 列表筛选。 */
export interface EgiuLessonFilter {
  stageId?: string | null;
  color?: EgiuColor | 'ALL';
  q?: string;
}

/**
 * 存储在 `errorBreakdown` 里的 JSON 键（snake_case，与 schema 注释一致）。
 *
 * 这里刻意用 `type` + 索引签名而不是 `interface`：`parseObject<T>` 的约束是
 * `Record<string, unknown>`，普通 interface 没有隐式索引签名，会触发 TS2344。
 * 索引签名同时如实描述了「DB 里可能存着历史遗留的额外键」这一事实。
 */
type StoredErrorBreakdown = Record<string, unknown> & {
  rule_unclear?: number;
  memory_confusion?: number;
  careless?: number;
  vocab?: number;
};

/** JSON → 读模型。 */
function toBreakdown(raw: string | null): EgiuErrorBreakdownDto | null {
  if (!raw) return null;
  const parsed = parseObject<StoredErrorBreakdown>(raw, {});
  const breakdown: EgiuErrorBreakdownDto = {
    ruleUnclear: Number(parsed.rule_unclear ?? 0),
    memoryConfusion: Number(parsed.memory_confusion ?? 0),
    careless: Number(parsed.careless ?? 0),
    vocab: Number(parsed.vocab ?? 0),
  };
  const empty =
    breakdown.ruleUnclear === 0 &&
    breakdown.memoryConfusion === 0 &&
    breakdown.careless === 0 &&
    breakdown.vocab === 0;
  return empty ? null : breakdown;
}

/** EGIU 单元列表。 */
export async function listEgiuLessons(filter: EgiuLessonFilter = {}): Promise<EgiuLessonRowDto[]> {
  const where: Prisma.EgiuLessonWhereInput = { archivedAt: null };
  if (filter.stageId) where.stageId = filter.stageId;
  if (filter.color && filter.color !== 'ALL') where.currentColor = filter.color;
  if (filter.q && filter.q.trim().length > 0) {
    const q = filter.q.trim();
    where.OR = [
      { knowledgePoint: { contains: q } },
      { unitNo: { contains: q } },
      { book: { contains: q } },
    ];
  }

  const [rows, pending, todayStr] = await Promise.all([
    prisma.egiuLesson.findMany({
      where,
      orderBy: [{ learnedDate: 'desc' }, { unitNo: 'asc' }],
      include: { resource: { select: { name: true } } },
      take: 500,
    }),
    prisma.reviewTask.findMany({
      where: { targetType: 'EGIU_LESSON', status: 'PENDING' },
      select: { targetId: true, dueDate: true },
    }),
    businessToday(),
  ]);

  const counters = new Map<string, { pending: number; overdue: number }>();
  for (const task of pending) {
    const current = counters.get(task.targetId) ?? { pending: 0, overdue: 0 };
    current.pending += 1;
    if (task.dueDate < todayStr) current.overdue += 1;
    counters.set(task.targetId, current);
  }

  return rows.map((row) => {
    const counter = counters.get(row.id) ?? { pending: 0, overdue: 0 };
    return {
      id: row.id,
      stageId: row.stageId,
      unitNo: row.unitNo,
      knowledgePoint: row.knowledgePoint,
      book: row.book,
      version: row.version,
      currentColor: row.currentColor as EgiuColor,
      currentScore: row.currentScore,
      currentReason: row.currentReason,
      learnedDate: row.learnedDate,
      greenStreak: row.greenStreak,
      mastered: row.masteredAt !== null,
      masteredAt: row.masteredAt ? row.masteredAt.toISOString() : null,
      inLowFreqPool: row.inLowFreqPool,
      nextReviewDate: row.nextReviewDate,
      retestCount: row.retestCount,
      resourceId: row.resourceId,
      resourceName: row.resource?.name ?? null,
      pendingReviewCount: counter.pending,
      overdueReviewCount: counter.overdue,
    };
  });
}

/** 复测记录 → DTO。 */
function toReviewDto(row: {
  id: string;
  reviewDate: string;
  reviewStage: string;
  totalQuestions: number;
  correctQuestions: number;
  explainOk: boolean;
  sentencesCount: number;
  coreRuleOk: boolean;
  judgedColor: string;
  judgeReason: string;
  judgeBranch: string;
  score: number | null;
  errorBreakdown: string | null;
  reviewTaskId: string | null;
  createdAt: Date;
}): EgiuReviewRowDto {
  const stage = row.reviewStage as ReviewStageCode;
  const branch = row.judgeBranch as JudgeBranch;
  return {
    id: row.id,
    reviewDate: row.reviewDate,
    reviewStage: stage,
    reviewStageLabel: REVIEW_STAGE_LABEL_ZH[stage] ?? row.reviewStage,
    totalQuestions: row.totalQuestions,
    correctQuestions: row.correctQuestions,
    accuracy: accuracyOf(row.correctQuestions, row.totalQuestions),
    explainOk: row.explainOk,
    sentencesCount: row.sentencesCount,
    coreRuleOk: row.coreRuleOk,
    judgedColor: row.judgedColor as EgiuColor,
    judgeReason: row.judgeReason,
    judgeBranch: branch,
    judgeBranchLabel: JUDGE_BRANCH_LABEL_ZH[branch] ?? row.judgeBranch,
    score: row.score,
    errorBreakdown: toBreakdown(row.errorBreakdown),
    reviewTaskId: row.reviewTaskId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 掌握度说明文案（把硬规则翻译成人话，页面直接展示）。 */
function masteryNoteOf(lesson: {
  masteredAt: Date | null;
  greenStreak: number;
  inLowFreqPool: boolean;
}, timeZone: string): string {
  if (lesson.masteredAt) {
    return `已于 ${toBusinessDate(lesson.masteredAt, timeZone)} 判定掌握（连续 ${MASTERY_GREEN_STREAK} 次绿灯且间隔 ≥${MASTERY_MIN_GAP_DAYS} 天）${
      lesson.inLowFreqPool ? '，已转 30 天低频抽测池' : ''
    }`;
  }
  if (lesson.greenStreak > 0) {
    return `当前连续 ${lesson.greenStreak} 次绿灯；需连续 ${MASTERY_GREEN_STREAK} 次且两次间隔 ≥${MASTERY_MIN_GAP_DAYS} 天才判为掌握`;
  }
  return `未掌握：需连续 ${MASTERY_GREEN_STREAK} 次绿灯且间隔 ≥${MASTERY_MIN_GAP_DAYS} 天`;
}

/** 从复测序列推出「掌握度变化」时间线。 */
function buildMasteryChanges(reviews: EgiuReviewRowDto[]): EgiuMasteryChangeDto[] {
  const sorted = [...reviews].sort((a, b) => (a.reviewDate < b.reviewDate ? -1 : 1));
  const changes: EgiuMasteryChangeDto[] = [];
  let previous: EgiuColor | null = null;

  for (const review of sorted) {
    if (previous === null || previous !== review.judgedColor) {
      changes.push({
        label: review.reviewStageLabel,
        fromColor: previous,
        toColor: review.judgedColor,
        changedAt: review.reviewDate,
        note: previous === null ? '首次判定' : `${EGIU_COLOR_LABEL_ZH[previous]} → ${EGIU_COLOR_LABEL_ZH[review.judgedColor]}`,
      });
    }
    previous = review.judgedColor;
  }

  return changes;
}

/** EGIU 单元详情。 */
export async function getEgiuLessonDetail(
  id: string,
  nowDateParam?: string,
): Promise<EgiuLessonDetailDto | null> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const timeZone = await getBusinessTimezone();
  const lesson = await prisma.egiuLesson.findUnique({
    where: { id },
    include: {
      resource: { select: { name: true } },
      stage: { select: { code: true } },
      reviews: { orderBy: [{ reviewDate: 'asc' }, { createdAt: 'asc' }] },
    },
  });
  if (!lesson) return null;

  const reviews = lesson.reviews.map(toReviewDto);
  const upcoming = await listUpcomingReviews('EGIU_LESSON', lesson.id, nowDate);

  const stageCode = lesson.stage.code as StageCode;
  const stageMeta = STAGE_META[stageCode];

  return {
    stageId: lesson.stageId,
    egiuAllowed: stageMeta ? stageMeta.allowedEgiu : false,
    masteryNote: masteryNoteOf(lesson, timeZone),
    reviews,
    upcoming,
    masteryChanges: buildMasteryChanges(reviews),
    lesson: {
      id: lesson.id,
      stageId: lesson.stageId,
      unitNo: lesson.unitNo,
      knowledgePoint: lesson.knowledgePoint,
      book: lesson.book,
      version: lesson.version,
      currentColor: lesson.currentColor as EgiuColor,
      currentScore: lesson.currentScore,
      currentReason: lesson.currentReason,
      learnedDate: lesson.learnedDate,
      greenStreak: lesson.greenStreak,
      mastered: lesson.masteredAt !== null,
      masteredAt: lesson.masteredAt ? lesson.masteredAt.toISOString() : null,
      inLowFreqPool: lesson.inLowFreqPool,
      nextReviewDate: lesson.nextReviewDate,
      retestCount: lesson.retestCount,
      resourceId: lesson.resourceId,
      resourceName: lesson.resource?.name ?? null,
      pendingReviewCount: upcoming.length,
      overdueReviewCount: upcoming.filter((item) => item.dueDate < nowDate).length,
    },
  };
}

/** 三色分布（每个单元只取最新判定，禁止按复测记录条数统计）。 */
export async function getEgiuColorCounts(): Promise<Record<EgiuColor, number>> {
  const rows = await prisma.egiuLesson.findMany({
    where: { archivedAt: null },
    select: { currentColor: true },
  });
  const out: Record<EgiuColor, number> = { PENDING: 0, GREEN: 0, YELLOW: 0, RED: 0 };
  for (const row of rows) {
    const color = row.currentColor as EgiuColor;
    if (color in out) out[color] += 1;
  }
  return out;
}

/** 页面顶部统计条。 */
export async function getEgiuSummary(nowDateParam?: string): Promise<{
  total: number;
  colors: Record<EgiuColor, number>;
  mastered: number;
  lowFreq: number;
  overdueLessons: number;
  reviewsThisWeek: number;
  today: string;
}> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const [rows, colors, overdue, reviewsThisWeek] = await Promise.all([
    prisma.egiuLesson.findMany({
      where: { archivedAt: null },
      select: { masteredAt: true, inLowFreqPool: true },
    }),
    getEgiuColorCounts(),
    prisma.reviewTask.count({
      where: { targetType: 'EGIU_LESSON', status: 'PENDING', dueDate: { lt: nowDate } },
    }),
    prisma.egiuReview.count({ where: { reviewDate: { gte: startOfIsoWeek(nowDate) } } }),
  ]);

  return {
    total: rows.length,
    colors,
    mastered: rows.filter((row) => row.masteredAt !== null).length,
    lowFreq: rows.filter((row) => row.inLowFreqPool).length,
    overdueLessons: overdue,
    reviewsThisWeek: reviewsThisWeek,
    today: nowDate,
  };
}
