/**
 * 计划页只读查询。
 *
 * 一个特殊职责：每次读取前先执行 `sweepStaleTasks`（幂等），把「过去日期仍未结束」
 * 的任务置为 `MISSED`。不引入 cron —— 单用户场景下读时清扫足够（架构 §10 第 7 条）。
 */

import {
  MODULE_META,
  TASK_STATUSES,
  TASK_STATUSES_EXCLUDED_FROM_RATE,
  TZ_NAME,
} from '@/lib/constants';
import { listDateRange, today, weekRange } from '@/lib/date';
import { completionRate } from '@/lib/domain/completion';
import { grammarCapMinutes, grammarMinutesOf } from '@/lib/domain/plan';
import { prisma } from '@/lib/prisma';
import type {
  CompletionItem,
  DailySummaryDto,
  LearningTrack,
  ModuleId,
  PlanPageDto,
  PlanTaskDto,
  PrimarySkill,
  ResourceOptionDto,
  SkillId,
  StageCode,
  TaskPriority,
  TaskSourceKind,
  TaskStatus,
  TimerStatus,
} from '@/lib/types';
import { getActiveStage } from './stages';
import { getEffectiveBudget } from './budget';

/** 未结束状态集合（清扫目标）。 */
const STALE_STATUSES = ['TODO', 'IN_PROGRESS'];

/**
 * 把 `planDate < today` 且仍未结束的任务置为 `MISSED`。
 *
 * 幂等：`updateMany` 只命中目标集合，重复调用不会再改任何行。
 */
export async function sweepStaleTasks(now: string = today()): Promise<number> {
  const result = await prisma.planTask.updateMany({
    where: { planDate: { lt: now }, status: { in: STALE_STATUSES } },
    data: { status: 'MISSED', statusChangedAt: new Date() },
  });
  return result.count;
}

/** 某日的净时长（只从 daySplit 求和，绝不从 `sessionDate` 单值推算）。 */
export async function getNetMinutesOfDate(date: string): Promise<number> {
  const aggregate = await prisma.studySessionDaySplit.aggregate({
    where: { date },
    _sum: { minutes: true },
  });
  return aggregate._sum.minutes ?? 0;
}

/** 资源下拉选项（数据驱动，代码无资源名枚举）。 */
export async function listResourceOptions(): Promise<ResourceOptionDto[]> {
  const resources = await prisma.resource.findMany({
    where: { archivedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, subject: true, type: true, isPrimary: true },
  });
  return resources;
}

/** 计划页全量 DTO。 */
export async function getPlanPage(planDate: string): Promise<PlanPageDto> {
  await sweepStaleTasks();

  const [stage, tasks, resources, summary, budget, versionCount, netMinutes] =
    await Promise.all([
      getActiveStage(),
      prisma.planTask.findMany({
        where: { planDate },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { resource: { select: { name: true } } },
      }),
      listResourceOptions(),
      prisma.dailySummary.findUnique({ where: { summaryDate: planDate } }),
      getEffectiveBudget(planDate),
      prisma.planVersion.count({ where: { planDate } }),
      getNetMinutesOfDate(planDate),
    ]);

  const taskDtos: PlanTaskDto[] = tasks.map((task) => ({
    id: task.id,
    module: task.module as ModuleId,
    moduleLabel: MODULE_META[task.module as ModuleId]?.labelZh ?? task.module,
    skill: task.skill as SkillId,
    track: task.track as LearningTrack,
    primarySkill: task.primarySkill as PrimarySkill,
    plannedMinutes: task.plannedMinutes,
    actualMinutes: task.actualMinutes,
    sortOrder: task.sortOrder,
    status: (TASK_STATUSES.includes(task.status as TaskStatus)
      ? task.status
      : 'TODO') as TaskStatus,
    movedCount: task.movedCount,
    resourceId: task.resourceId,
    resourceName: task.resource?.name ?? null,
    note: task.note,
    timerStatus: task.timerStatus as TimerStatus,
    timerStartedAt: task.timerStartedAt ? task.timerStartedAt.toISOString() : null,
    timerAccumulatedSeconds: task.timerAccumulatedSeconds,
    timerVersion: task.timerVersion,
    priority: (task.priority ?? 'P1') as TaskPriority,
    splittable: task.splittable,
    planVersion: task.planVersion,
    originalScheduledDate: task.originalScheduledDate,
    sourceKind: (task.sourceKind ?? 'LEGACY') as TaskSourceKind,
    deferReason: task.deferReason,
  }));

  // 顺延任务的真实归属（缺陷 D5）：`movedFromDate` 必须来自库，否则
  // 「原日剔除」永远不生效，顺延任务会在两个日期各被统计一次。
  const completionItems: CompletionItem[] = tasks.map((task) => ({
    plannedMinutes: task.plannedMinutes,
    actualMinutes: task.actualMinutes,
    status: (TASK_STATUSES.includes(task.status as TaskStatus)
      ? task.status
      : 'TODO') as TaskStatus,
    movedFromDate: task.movedFromDate,
    movedToDate: task.movedToDate,
  }));

  // 「计划时长」与完成率分母同口径：CANCELLED / DEFERRED 已被移出当日，
  // 再计入会让重排后的页面显示「计划 150 分 > 预算 90 分」的假超排。
  const scheduledTasks = taskDtos.filter(
    (task) => !TASK_STATUSES_EXCLUDED_FROM_RATE.includes(task.status),
  );
  const totalPlannedMinutes = scheduledTasks.reduce((sum, task) => sum + task.plannedMinutes, 0);
  const totalActualMinutes = taskDtos.reduce((sum, task) => sum + task.actualMinutes, 0);

  const summaryDto: DailySummaryDto | null = summary
    ? {
        summaryDate: summary.summaryDate,
        netMinutes: summary.netMinutes,
        draftText: summary.draftText,
        completionRateByTime: summary.completionRateByTime,
        completionRateByCount: summary.completionRateByCount,
      }
    : null;

  return {
    planDate,
    stageId: stage?.id ?? null,
    stageCode: (stage?.code as StageCode) ?? null,
    stageName: stage?.nameZh ?? null,
    totalPlannedMinutes,
    totalActualMinutes,
    grammarPlannedMinutes: grammarMinutesOf(scheduledTasks),
    grammarCapMinutes: grammarCapMinutes(totalPlannedMinutes),
    grammarOverCap:
      !!stage &&
      stage.code === 'S1_A0_A2' &&
      totalPlannedMinutes > 0 &&
      grammarMinutesOf(scheduledTasks) > grammarCapMinutes(totalPlannedMinutes),
    tasks: taskDtos,
    completion: completionRate(completionItems, planDate),
    netMinutes,
    dailySummary: summaryDto,
    availableResources: resources,
    budget: {
      minutes: budget.minutes,
      isRestDay: budget.isRestDay,
      source: budget.source,
      isSuggestion: budget.isSuggestion,
      tierCode: budget.tierCode,
    },
    planVersionCount: versionCount,
  };
}

/** 某日是否已有任务（生成计划前的幂等判断）。 */
export async function countTasksOfDate(planDate: string): Promise<number> {
  return prisma.planTask.count({ where: { planDate } });
}

/** 周条带：某日期所在 ISO 周每天的「计划分钟 / 净时长 / 任务数」。 */
export interface WeekStripDay {
  date: string;
  plannedMinutes: number;
  netMinutes: number;
  taskCount: number;
  doneCount: number;
}

export async function getWeekStrip(date: string): Promise<WeekStripDay[]> {
  const { weekStart, weekEnd } = weekRange(date);
  const dates = listDateRange(weekStart, weekEnd);

  const [tasks, splits] = await Promise.all([
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

  const netByDate = new Map<string, number>();
  for (const row of splits) netByDate.set(row.date, row._sum.minutes ?? 0);

  return dates.map((day) => {
    // 与计划页统计卡同口径：CANCELLED / DEFERRED 已移出当日，不计入计划分钟与任务数
    const dayTasks = tasks.filter(
      (task) =>
        task.planDate === day &&
        !TASK_STATUSES_EXCLUDED_FROM_RATE.includes(task.status as TaskStatus),
    );
    return {
      date: day,
      plannedMinutes: dayTasks.reduce((sum, task) => sum + task.plannedMinutes, 0),
      netMinutes: netByDate.get(day) ?? 0,
      taskCount: dayTasks.length,
      doneCount: dayTasks.filter((task) => task.status === 'DONE').length,
    };
  });
}

/** 时区展示名（页面副标题用，只读）。 */
export function timezoneLabel(): string {
  return TZ_NAME;
}
