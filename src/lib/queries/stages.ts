/**
 * 阶段与验收的只读查询。
 *
 * 阶段名一律带「训练区间」措辞，且页面必须并置 CEFR 免责声明 —— 这里不改文案，
 * 只保证数据里的 `nameZh` 与 `constants.STAGE_META` 一致。
 */

import type { Stage } from '@prisma/client';
import {
  ACCEPTANCE_DIMENSION_LABEL_ZH,
  GATE_H3_WINDOW_DAYS,
  GATE_H4_WINDOW_DAYS,
  STAGE_STATUSES,
} from '@/lib/constants';
import { addDays, diffDays, lastNDays, today } from '@/lib/date';
import { evaluateStageGate } from '@/lib/domain/stageGate';
import { prisma } from '@/lib/prisma';
import type {
  AcceptanceDimension,
  AcceptanceItemDto,
  EgiuColor,
  GateResult,
  IntervalCode,
  ReviewResult,
  ReviewStatus,
  StageCode,
  StageStatus,
  StageTimelineItemDto,
  Verdict,
} from '@/lib/types';

/** 当前 ACTIVE 阶段；没有则取 sortOrder 最小的一个。 */
export async function getActiveStage(): Promise<Stage | null> {
  const active = await prisma.stage.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { sortOrder: 'asc' },
  });
  if (active) return active;
  return prisma.stage.findFirst({ orderBy: { sortOrder: 'asc' } });
}

/** 全部阶段（seed 保证 4 行）。 */
export async function listStagesRaw(): Promise<Stage[]> {
  return prisma.stage.findMany({ orderBy: { sortOrder: 'asc' } });
}

/** 阶段时间线 DTO（含已进行天数与验收通过数）。 */
export async function listStageTimeline(now: string = today()): Promise<StageTimelineItemDto[]> {
  const stages = await prisma.stage.findMany({
    orderBy: { sortOrder: 'asc' },
    include: { acceptanceItems: { select: { verdict: true, isRequired: true } } },
  });

  return stages.map((stage) => {
    const passedCount = stage.acceptanceItems.filter((item) => item.verdict === 'PASSED').length;
    const requiredTotal = stage.acceptanceItems.filter((item) => item.isRequired).length;
    const status: StageStatus = STAGE_STATUSES.includes(stage.status as StageStatus)
      ? (stage.status as StageStatus)
      : 'NOT_STARTED';
    return {
      id: stage.id,
      code: stage.code as StageCode,
      nameZh: stage.nameZh,
      estDaysMin: stage.estDaysMin,
      estDaysMax: stage.estDaysMax,
      status,
      startedAt: stage.startedAt,
      completedAt: stage.completedAt,
      elapsedDays: stage.startedAt ? Math.max(0, diffDays(stage.startedAt, now)) : 0,
      passedCount,
      requiredTotal,
      isActive: status === 'ACTIVE',
    };
  });
}

/** 某阶段的 7 维度验收清单。 */
export async function listAcceptanceItems(stageId: string): Promise<AcceptanceItemDto[]> {
  const items = await prisma.stageAcceptanceItem.findMany({
    where: { stageId },
    orderBy: { sortOrder: 'asc' },
  });
  return items.map((item) => ({
    id: item.id,
    dimension: item.dimension as AcceptanceDimension,
    dimensionLabel:
      ACCEPTANCE_DIMENSION_LABEL_ZH[item.dimension as AcceptanceDimension] ?? item.dimension,
    isRequired: item.isRequired,
    criterionText: item.criterionText,
    myResult: item.myResult,
    evidence: item.evidence,
    verdict: (item.verdict as Verdict) ?? 'PENDING',
    judgedAt: item.judgedAt,
  }));
}

/** 阶段流转日志（只增不删，倒序展示）。 */
export async function listTransitionLogs(limit = 20) {
  return prisma.stageTransitionLog.findMany({
    orderBy: { decidedAt: 'desc' },
    take: limit,
  });
}

/**
 * 计算某阶段的 H1–H5 门禁。
 *
 * 只读、不改库 —— 系统**永不**自动切换阶段，这个函数只输出「建议 + 未满足项」。
 */
export async function getStageGate(
  stageId: string,
  now: string = today(),
): Promise<GateResult | null> {
  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage) return null;

  const [acceptance, reviewTasks, plannedDatesRaw, splitRows, lessons] = await Promise.all([
    prisma.stageAcceptanceItem.findMany({
      where: { stageId },
      select: {
        dimension: true,
        isRequired: true,
        verdict: true,
        myResult: true,
        evidence: true,
        judgedAt: true,
      },
    }),
    prisma.reviewTask.findMany({
      where: { dueDate: { gte: addDays(now, -GATE_H3_WINDOW_DAYS), lte: now } },
      select: { intervalCode: true, status: true, dueDate: true, result: true },
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: addDays(now, -(GATE_H4_WINDOW_DAYS - 1)), lte: now } },
      select: { planDate: true },
      distinct: ['planDate'],
    }),
    prisma.studySessionDaySplit.groupBy({
      by: ['date'],
      where: { date: { gte: addDays(now, -(GATE_H4_WINDOW_DAYS - 1)), lte: now } },
      _sum: { minutes: true },
    }),
    prisma.egiuLesson.findMany({ where: { archivedAt: null }, select: { currentColor: true } }),
  ]);

  const netByDate = new Map<string, number>();
  for (const row of splitRows) netByDate.set(row.date, row._sum.minutes ?? 0);
  const plannedDates = new Set(plannedDatesRaw.map((row) => row.planDate));

  return evaluateStageGate({
    stageStart: stage.startedAt,
    stageEnd: stage.completedAt,
    today: now,
    acceptance: acceptance.map((item) => ({
      dimension: item.dimension,
      isRequired: item.isRequired,
      verdict: item.verdict as Verdict,
      myResult: item.myResult,
      evidence: item.evidence,
      judgedAt: item.judgedAt,
    })),
    reviewTasks: reviewTasks.map((task) => ({
      intervalCode: task.intervalCode as IntervalCode,
      status: task.status as ReviewStatus,
      dueDate: task.dueDate,
      result: (task.result as ReviewResult | null) ?? null,
    })),
    days: lastNDays(GATE_H4_WINDOW_DAYS, now).map((date) => ({
      date,
      hasPlan: plannedDates.has(date),
      netMinutes: netByDate.get(date) ?? 0,
    })),
    lessons: lessons.map((lesson) => ({ currentColor: lesson.currentColor as EgiuColor })),
  });
}
