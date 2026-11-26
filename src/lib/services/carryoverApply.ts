import type { Prisma, PlanTask } from '@prisma/client';
import { MODULE_META } from '@/lib/constants';
import {
  carryoverPolicy,
  carryoverTaskFingerprint,
  type CarryoverDecisionView,
  type CarryoverPreview,
  type CarryoverResult,
  type OverdueTask,
} from '@/lib/domain/carryover';
import { prisma } from '@/lib/prisma';
import { ok } from '@/lib/result';
import type { ActionResult, ModuleId, TaskPriority, TaskStatus } from '@/lib/types';

type DbClient = typeof prisma | Prisma.TransactionClient;

export interface ApplyCarryoverInput {
  targetDate: string;
  decisions: CarryoverResult['decisions'];
  expectedFingerprint: string;
}

export interface CarryoverApplyResult {
  promoted: number;
  demoted: number;
  backlogged: number;
  abandoned: number;
}

export class CarryoverConflictError extends Error {
  readonly code = 'CONFLICT' as const;

  constructor() {
    super('上期任务在预览后已变化，请重新生成预览');
    this.name = 'CarryoverConflictError';
  }
}

export async function effectiveActualMinutesByTask(
  tasks: readonly PlanTask[],
  db: DbClient = prisma,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (tasks.length === 0) return result;

  const sessions = await db.studySession.findMany({
    where: {
      taskId: { in: tasks.map((task) => task.id) },
      terminatedReason: { notIn: ['ABANDONED', 'TIMEOUT'] },
    },
    select: { taskId: true, sessionDate: true, activeMinutes: true },
  });
  const planDateByTask = new Map(tasks.map((task) => [task.id, task.planDate]));
  for (const session of sessions) {
    if (!session.taskId) continue;
    const planDate = planDateByTask.get(session.taskId);
    if (!planDate || session.sessionDate < planDate) continue;
    result.set(session.taskId, (result.get(session.taskId) ?? 0) + Math.max(0, session.activeMinutes));
  }
  for (const task of tasks) {
    result.set(task.id, Math.max(Math.max(0, task.actualMinutes), result.get(task.id) ?? 0));
  }
  return result;
}

export async function loadOverdueTasks(
  asOfDate: string,
  db: DbClient = prisma,
): Promise<OverdueTask[]> {
  const rows = await db.planTask.findMany({
    where: {
      planDate: { lt: asOfDate },
      status: { in: ['TODO', 'IN_PROGRESS', 'MISSED'] },
      timerStatus: 'IDLE',
    },
    orderBy: [{ planDate: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) return [];

  const recordedByTask = await effectiveActualMinutesByTask(rows, db);

  return rows.flatMap((row) => {
    const actualMinutes = recordedByTask.get(row.id) ?? 0;
    if (actualMinutes >= row.plannedMinutes) return [];
    return [{
      taskId: row.id,
      module: row.module as ModuleId,
      priority: row.priority as TaskPriority,
      plannedMinutes: row.plannedMinutes,
      actualMinutes,
      status: row.status as TaskStatus,
      planDate: row.planDate,
      originalScheduledDate: row.originalScheduledDate,
      planVersion: row.planVersion,
      movedCount: row.movedCount,
      splittable: row.splittable,
      minChunkMinutes: row.minChunkMinutes,
      deferReason: row.deferReason,
      timerStatus: row.timerStatus,
      timerVersion: row.timerVersion,
      movedToDate: row.movedToDate,
    }];
  });
}

export async function previewCarryover(
  asOfDate: string,
  budgetMinutes: number,
): Promise<CarryoverPreview> {
  const overdue = await loadOverdueTasks(asOfDate);
  const result = carryoverPolicy({ asOfDate, overdue, budgetMinutes });
  const byId = new Map(overdue.map((task) => [task.taskId, task]));
  const decisions: CarryoverDecisionView[] = result.decisions.map((decision) => {
    const task = byId.get(decision.taskId)!;
    const verdict = decision.verdict;
    const finalPriority = verdict.action === 'PROMOTE' || verdict.action === 'DEMOTE'
      ? verdict.toPriority
      : null;
    const destination = verdict.action === 'PROMOTE'
      ? `纳入 ${asOfDate}，优先级 ${finalPriority}`
      : verdict.action === 'DEMOTE'
        ? `纳入 ${asOfDate}，优先级降至 ${finalPriority}`
        : verdict.action === 'BACKLOG'
          ? '进入 Backlog（DEFERRED），不自动排入当天'
          : '本次放弃（CANCELLED），保留任务与原因';
    return {
      taskId: task.taskId,
      module: task.module,
      originalDate: task.originalScheduledDate ?? task.planDate,
      previousPlanDate: task.planDate,
      previousPlanVersion: task.planVersion ?? 1,
      previousPriority: task.priority,
      finalPriority,
      plannedMinutes: task.plannedMinutes,
      actualMinutes: task.actualMinutes,
      remainingMinutes: Math.max(0, task.plannedMinutes - task.actualMinutes),
      movedCount: task.movedCount,
      splittable: task.splittable,
      minChunkMinutes: task.minChunkMinutes,
      overdueDays: decision.overdueDays,
      action: verdict.action,
      reason: verdict.reason,
      destination,
    };
  });
  return {
    asOfDate,
    budgetMinutes,
    fingerprint: carryoverTaskFingerprint(overdue),
    decisions,
    promotedCount: result.promotedCount,
    demotedCount: result.demotedCount,
    backlogCount: result.backlogCount,
    abandonedCount: result.abandonedCount,
    overflowCount: result.overflowCount,
    warnings: result.warnings,
  };
}

export async function applyCarryoverInTransaction(
  tx: Prisma.TransactionClient,
  input: ApplyCarryoverInput,
): Promise<CarryoverApplyResult> {
  const current = await loadOverdueTasks(input.targetDate, tx);
  if (carryoverTaskFingerprint(current) !== input.expectedFingerprint) {
    throw new CarryoverConflictError();
  }
  const currentById = new Map(current.map((task) => [task.taskId, task]));
  const decisionIds = input.decisions.map((decision) => decision.taskId);
  if (new Set(decisionIds).size !== decisionIds.length
    || decisionIds.length !== currentById.size
    || decisionIds.some((id) => !currentById.has(id))) {
    throw new CarryoverConflictError();
  }

  let promoted = 0;
  let demoted = 0;
  let backlogged = 0;
  let abandoned = 0;

  for (const decision of input.decisions) {
    const task = await tx.planTask.findUnique({ where: { id: decision.taskId } });
    if (!task) throw new CarryoverConflictError();
    const overdue = currentById.get(decision.taskId);
    if (!overdue) throw new CarryoverConflictError();
    const actualMinutes = overdue.actualMinutes;
    const remainingMinutes = Math.max(0, task.plannedMinutes - actualMinutes);
    const expectedWhere = {
      id: task.id,
      planDate: task.planDate,
      originalScheduledDate: task.originalScheduledDate,
      movedFromDate: task.movedFromDate,
      movedToDate: task.movedToDate,
      status: task.status,
      timerStatus: task.timerStatus,
      timerVersion: task.timerVersion,
      priority: task.priority,
      plannedMinutes: task.plannedMinutes,
      actualMinutes: task.actualMinutes,
      movedCount: task.movedCount,
      splittable: task.splittable,
      minChunkMinutes: task.minChunkMinutes,
      deferReason: task.deferReason,
    } as const;

    const movedFromDate = task.movedFromDate ?? task.originalScheduledDate ?? task.planDate;
    const verdict = decision.verdict;

    if (verdict.action === 'PROMOTE' || verdict.action === 'DEMOTE') {
      const changed = await tx.planTask.updateMany({
        where: expectedWhere,
        data: {
          planDate: input.targetDate,
          movedToDate: input.targetDate,
          movedFromDate,
          movedCount: task.movedCount + 1,
          plannedMinutes: remainingMinutes,
          actualMinutes: 0,
          priority: verdict.toPriority,
          status: 'TODO',
          statusChangedAt: new Date(),
          rescheduleReason: verdict.reason,
          deferReason: null,
        },
      });
      if (changed.count !== 1) throw new CarryoverConflictError();
      if (verdict.action === 'PROMOTE') promoted += 1;
      else demoted += 1;
    } else if (verdict.action === 'BACKLOG') {
      const changed = await tx.planTask.updateMany({
        where: expectedWhere,
        data: {
          status: 'DEFERRED',
          statusChangedAt: new Date(),
          movedCount: task.movedCount + 1,
          movedFromDate,
          deferReason: verdict.reason,
          rescheduleReason: verdict.reason,
        },
      });
      if (changed.count !== 1) throw new CarryoverConflictError();
      backlogged += 1;
    } else {
      const changed = await tx.planTask.updateMany({
        where: expectedWhere,
        data: {
          status: 'CANCELLED',
          statusChangedAt: new Date(),
          deferReason: verdict.reason,
          rescheduleReason: verdict.reason,
        },
      });
      if (changed.count !== 1) throw new CarryoverConflictError();
      abandoned += 1;
    }
  }

  return { promoted, demoted, backlogged, abandoned };
}

export async function applyCarryover(
  input: ApplyCarryoverInput,
): Promise<ActionResult<CarryoverApplyResult>> {
  const result = await prisma.$transaction((tx) => applyCarryoverInTransaction(tx, input));
  return ok(result);
}

export function carryoverModuleLabel(module: string): string {
  return MODULE_META[module as ModuleId]?.labelZh ?? module;
}
