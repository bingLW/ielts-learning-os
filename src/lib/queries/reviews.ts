/**
 * 统一复习队列的只读查询（T24 / T28）。
 *
 * 四类目标（EGIU 单元 / 错题 / 单词 / 语法点）共用 `ReviewTask` 一张表，
 * 所以这里只有一套聚合逻辑 —— 不存在「每类各自查一遍」的分叉。
 */

import {
  INTERVAL_LABEL_ZH,
  REVIEW_BUCKET_WEEK_DAYS,
  TARGET_TYPE_LABEL_ZH,
} from '@/lib/constants';
import { resolveBusinessDate } from '@/lib/businessTime';
import { addDays, diffDays } from '@/lib/date';
import { isReviewLoadHeavy } from '@/lib/domain/duration';
import { prisma } from '@/lib/prisma';
import type {
  IntervalCode,
  ReviewBucketDto,
  ReviewCenterDto,
  ReviewResult,
  ReviewStatus,
  ReviewTaskRowDto,
  TargetType,
} from '@/lib/types';

/** `ReviewTask` 的最小结构化类型（便于纯函数复用，不依赖 Prisma 生成类型）。 */
export interface ReviewTaskRecord {
  id: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  knowledgePoint: string | null;
  intervalCode: string;
  dueDate: string;
  status: string;
  estMinutes: number;
  result: string | null;
  completedAt: Date | null;
}

/** 单条复习任务 → DTO。逾期天数由 `today` 与服务端算好，客户端不参与。 */
export function toReviewTaskDto(row: ReviewTaskRecord, todayStr: string): ReviewTaskRowDto {
  const overdue = Math.max(0, diffDays(row.dueDate, todayStr));
  return {
    id: row.id,
    targetType: row.targetType as TargetType,
    targetTypeLabel: TARGET_TYPE_LABEL_ZH[row.targetType as TargetType] ?? row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    knowledgePoint: row.knowledgePoint,
    intervalCode: row.intervalCode as IntervalCode,
    intervalLabel: INTERVAL_LABEL_ZH[row.intervalCode as IntervalCode] ?? row.intervalCode,
    dueDate: row.dueDate,
    status: row.status as ReviewStatus,
    estMinutes: row.estMinutes,
    result: (row.result as ReviewResult | null) ?? null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    overdueDays: overdue,
    isOverdue: overdue > 0,
  };
}

/** 复习中心：按到期日分「逾期 / 今日 / 本周」三桶。 */
export async function getReviewCenter(nowDateParam?: string): Promise<ReviewCenterDto> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const weekEnd = addDays(nowDate, REVIEW_BUCKET_WEEK_DAYS - 1);

  const [rows, lowFreqRows, profile] = await Promise.all([
    prisma.reviewTask.findMany({
      where: { status: 'PENDING', dueDate: { lte: weekEnd } },
      orderBy: [{ dueDate: 'asc' }, { estMinutes: 'desc' }],
      take: 500,
    }),
    prisma.reviewTask.findMany({
      where: { intervalCode: 'LOW_FREQ_30', status: 'PENDING' },
      orderBy: { dueDate: 'asc' },
      take: 50,
    }),
    prisma.userProfile.findUnique({ where: { id: 1 } }),
  ]);

  const items = rows.map((row) => toReviewTaskDto(row, nowDate));
  const overdue = items.filter((item) => item.dueDate < nowDate);
  const dueToday = items.filter((item) => item.dueDate === nowDate);
  const week = items.filter((item) => item.dueDate > nowDate && item.dueDate <= weekEnd);

  const sumEst = (list: ReviewTaskRowDto[]) =>
    list.reduce((total, item) => total + Math.max(0, item.estMinutes), 0);

  const buckets: ReviewBucketDto[] = [
    {
      key: 'OVERDUE',
      title: '逾期',
      hint: '逾期任务不会自动改期，也不会消失 —— 做完才会离开队列',
      items: overdue,
      estMinutes: sumEst(overdue),
    },
    {
      key: 'TODAY',
      title: '今日到期',
      hint: '按间隔阶梯（D1 → D3 → D7 → D14）排到今天',
      items: dueToday,
      estMinutes: sumEst(dueToday),
    },
    {
      key: 'WEEK',
      title: '本周内到期',
      hint: `未来 ${REVIEW_BUCKET_WEEK_DAYS} 天内到期，可提前做但不建议提前太久`,
      items: week,
      estMinutes: sumEst(week),
    },
  ];

  const totalEstMinutes = sumEst(items);
  const dailyMinutes = profile?.dailyMinutes ?? 0;

  return {
    today: nowDate,
    overdueCount: overdue.length,
    dueTodayCount: dueToday.length,
    weekCount: week.length,
    totalEstMinutes,
    dailyMinutes,
    loadHeavy: isReviewLoadHeavy(totalEstMinutes, dailyMinutes),
    buckets,
    lowFreq: lowFreqRows.map((row) => toReviewTaskDto(row, nowDate)),
  };
}

/** 某个目标（单元 / 错题 / 单词）的未完成复习点。 */
export async function listUpcomingReviews(
  targetType: TargetType,
  targetId: string,
  nowDateParam?: string,
): Promise<ReviewTaskRowDto[]> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const rows = await prisma.reviewTask.findMany({
    where: { targetType, targetId, status: 'PENDING' },
    orderBy: { dueDate: 'asc' },
  });
  return rows.map((row) => toReviewTaskDto(row, nowDate));
}

/** 某个目标已完成 / 已跳过的复习历史（倒序）。 */
export async function listReviewHistory(
  targetType: TargetType,
  targetId: string,
  nowDateParam?: string,
  limit = 20,
): Promise<ReviewTaskRowDto[]> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const rows = await prisma.reviewTask.findMany({
    where: { targetType, targetId, status: { in: ['DONE', 'SKIPPED'] } },
    orderBy: [{ dueDate: 'desc' }],
    take: limit,
  });
  return rows.map((row) => toReviewTaskDto(row, nowDate));
}

/** 待复习总量（Dashboard / 侧栏角标用）。 */
export async function countPendingReviews(nowDateParam?: string): Promise<{
  dueToday: number;
  overdue: number;
  next7Days: number;
}> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const weekEnd = addDays(nowDate, REVIEW_BUCKET_WEEK_DAYS - 1);
  const [overdue, dueToday, next7] = await Promise.all([
    prisma.reviewTask.count({ where: { status: 'PENDING', dueDate: { lt: nowDate } } }),
    prisma.reviewTask.count({ where: { status: 'PENDING', dueDate: nowDate } }),
    prisma.reviewTask.count({
      where: { status: 'PENDING', dueDate: { gt: nowDate, lte: weekEnd } },
    }),
  ]);
  return { dueToday, overdue, next7Days: next7 };
}
