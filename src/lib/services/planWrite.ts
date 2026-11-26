import { MIN_TASK_MINUTES } from '@/lib/constants';
import {
  describeBudgetViolations,
  validateProposalAgainstBudget,
  type BudgetDay,
} from '@/lib/domain/taskProposal';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getEffectiveBudget } from '@/lib/queries/budget';
import { nextPlanVersion } from '@/lib/queries/planning';
import { loadPlanInventory, reservedMinutesForTask } from '@/lib/services/planInventory';
import { effectiveActualMinutesByTask } from '@/lib/services/carryoverApply';
import { fail, ok } from '@/lib/result';
import type {
  ActionResult,
  LearningTrack,
  ModuleId,
  PrimarySkill,
  SkillId,
  TaskPriority,
  TaskSourceKind,
} from '@/lib/types';

type WriteOrigin = 'MATERIAL_CONFIRM' | 'CANDIDATE_CONFIRM' | 'MANUAL_ADD' | 'RETEST_ADD';

const ORIGIN_AUDIT: Record<
  WriteOrigin,
  { changeSource: 'GENERATE' | 'MANUAL_ADJUST' | 'REPLAN'; reason: string }
> = {
  MATERIAL_CONFIRM: { changeSource: 'MANUAL_ADJUST', reason: '材料草案确认写入计划' },
  CANDIDATE_CONFIRM: { changeSource: 'GENERATE', reason: '候选任务确认写入计划' },
  MANUAL_ADD: { changeSource: 'MANUAL_ADJUST', reason: '手工新增任务' },
  RETEST_ADD: { changeSource: 'GENERATE', reason: '到期复测加入计划' },
};

export interface AppendTaskFromCandidateInput {
  stageId: string;
  planDate: string;
  module: ModuleId;
  skill: SkillId;
  plannedMinutes: number;
  priority: TaskPriority;
  sourceKind: TaskSourceKind;
  track: LearningTrack;
  primarySkill: PrimarySkill;
  minChunkMinutes?: number;
  /** 候选级可拆分性；单块计划不能因此丢失该标记。 */
  splittable?: boolean;
  resourceId?: string | null;
  note?: string | null;
  candidateId?: string | null;
  decisionJson?: string | null;
  proposalItemId?: string | null;
  idempotencyKey?: string | null;
  origin: WriteOrigin;
  budgetPrevalidated?: boolean;
}

export interface AppendTaskFromCandidateResult {
  taskId: string;
  planVersion: number;
  created: boolean;
  splittable: boolean;
  plannedMinutesAfter: number;
  warnings: string[];
}

async function reservedMinutesOnDate(
  planDate: string,
  db: Prisma.TransactionClient | typeof prisma,
): Promise<number> {
  const inventory = await loadPlanInventory(planDate, planDate, db);
  return inventory.reservedMinutesByDate.get(planDate) ?? 0;
}

export function validateBatchBudget(
  items: readonly { date: string; minutes: number }[],
  days: readonly BudgetDay[],
): ActionResult<{ violations: ReturnType<typeof validateProposalAgainstBudget>['violations'] }> {
  const check = validateProposalAgainstBudget(items, days);
  if (!check.ok) return fail('PRECONDITION', describeBudgetViolations(check.violations));
  return ok({ violations: check.violations });
}

export async function appendTaskFromCandidateInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendTaskFromCandidateInput,
): Promise<AppendTaskFromCandidateResult> {
  const minChunkMinutes = input.minChunkMinutes ?? MIN_TASK_MINUTES;
  const splittable = input.splittable ?? input.plannedMinutes > minChunkMinutes;
  const audit = ORIGIN_AUDIT[input.origin];

  if (input.proposalItemId) {
    const item = await tx.taskProposalItem.findUnique({
      where: { id: input.proposalItemId },
      select: { planTaskId: true },
    });
    if (item?.planTaskId) {
      const existing = await tx.planTask.findUnique({
        where: { id: item.planTaskId },
        select: { planVersion: true, plannedMinutes: true, splittable: true },
      });
      const plannedMinutesAfter = await reservedMinutesOnDate(input.planDate, tx);
      return {
        created: false,
        taskId: item.planTaskId,
        planVersion: existing?.planVersion ?? 1,
        splittable: existing?.splittable ?? splittable,
        plannedMinutesAfter,
        warnings: [],
      };
    }
  }

  if (input.idempotencyKey) {
    const hit = await tx.planVersion.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { version: true },
    });
    if (hit) {
      const existingTask = await tx.planTask.findFirst({
        where: { planDate: input.planDate, planVersion: hit.version },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, plannedMinutes: true, splittable: true },
      });
      if (existingTask) {
        const plannedMinutesAfter = await reservedMinutesOnDate(input.planDate, tx);
        return {
          created: false,
          taskId: existingTask.id,
          planVersion: hit.version,
          splittable: existingTask.splittable,
          plannedMinutesAfter,
          warnings: [],
        };
      }
    }
  }

  const existingMinutes = await reservedMinutesOnDate(input.planDate, tx);
  const budget = await getEffectiveBudget(input.planDate, tx);
  if (!input.budgetPrevalidated) {
    const check = validateProposalAgainstBudget(
      [{ date: input.planDate, minutes: existingMinutes + input.plannedMinutes }],
      [{ date: input.planDate, minutes: budget.minutes, isRestDay: budget.isRestDay }],
    );
    if (!check.ok) throw new BudgetGateError(describeBudgetViolations(check.violations));
  }

  const version = await nextPlanVersion(input.planDate, tx);
  const maxSort = await tx.planTask.aggregate({
    where: { planDate: input.planDate },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;
  const netAgg = await tx.studySessionDaySplit.aggregate({
    where: { date: input.planDate },
    _sum: { minutes: true },
  });
  const actualMinutesAtChange = netAgg._sum.minutes ?? 0;

  const task = await tx.planTask.create({
    data: {
      stageId: input.stageId,
      planDate: input.planDate,
      module: input.module,
      skill: input.skill,
      plannedMinutes: input.plannedMinutes,
      sortOrder,
      track: input.track,
      primarySkill: input.primarySkill,
      priority: input.priority,
      sourceKind: input.sourceKind,
      splittable,
      minChunkMinutes,
      planVersion: version,
      originalScheduledDate: input.planDate,
      resourceId: input.resourceId ?? null,
      note: input.note ?? null,
      candidateId: input.candidateId ?? null,
      decisionJson: input.decisionJson ?? null,
    },
    select: { id: true },
  });

  if (input.proposalItemId) {
    await tx.taskProposalItem.update({
      where: { id: input.proposalItemId },
      data: { planTaskId: task.id },
    });
  }

  const plannedMinutesAfter = existingMinutes + input.plannedMinutes;
  await tx.planVersion.create({
    data: {
      planDate: input.planDate,
      version,
      changeSource: audit.changeSource,
      reason: audit.reason,
      budgetMinutes: budget.minutes,
      actualMinutesAtChange,
      afterSnapshot: JSON.stringify({
        taskId: task.id,
        taskCount: 1,
        addedMinutes: input.plannedMinutes,
        plannedMinutesAfter,
        sourceKind: input.sourceKind,
      }),
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  return {
    created: true,
    taskId: task.id,
    planVersion: version,
    splittable,
    plannedMinutesAfter,
    warnings: budget.isSuggestion ? ['该日尚无显式预算，使用了系统建议值'] : [],
  };
}

export async function appendTaskBatchInTransaction(
  tx: Prisma.TransactionClient,
  inputs: readonly AppendTaskFromCandidateInput[],
  options: { primaryPlanDate?: string; budgetPrevalidated?: boolean } = {},
): Promise<{ taskIds: string[]; versions: { planDate: string; version: number; id: string }[] }> {
  if (inputs.length === 0) return { taskIds: [], versions: [] };
  const taskIds: string[] = [];
  const versions: { planDate: string; version: number; id: string }[] = [];
  const primaryPlanDate = options.primaryPlanDate ?? inputs[0].planDate;

  for (const planDate of [...new Set(inputs.map((input) => input.planDate))]) {
    const dayInputs = inputs.filter((input) => input.planDate === planDate);
    const [maxSort, netAgg, budget, existingMinutes] = await Promise.all([
      tx.planTask.aggregate({ where: { planDate }, _max: { sortOrder: true } }),
      tx.studySessionDaySplit.aggregate({ where: { date: planDate }, _sum: { minutes: true } }),
      getEffectiveBudget(planDate, tx),
      reservedMinutesOnDate(planDate, tx),
    ]);
    const addedMinutes = dayInputs.reduce((sum, input) => sum + input.plannedMinutes, 0);
    if (!options.budgetPrevalidated) {
      const check = validateProposalAgainstBudget(
        [{ date: planDate, minutes: existingMinutes + addedMinutes }],
        [{ date: planDate, minutes: budget.minutes, isRestDay: budget.isRestDay }],
      );
      if (!check.ok) throw new BudgetGateError(describeBudgetViolations(check.violations));
    }
    const version = await nextPlanVersion(planDate, tx);
    const sortBase = (maxSort._max.sortOrder ?? -1) + 1;
    const idempotencyKey = dayInputs.find((input) => input.idempotencyKey)?.idempotencyKey;
    const audit = ORIGIN_AUDIT[dayInputs[0].origin];
    const rows = await tx.planTask.createManyAndReturn({
      data: dayInputs.map((input, index) => {
        const minChunkMinutes = input.minChunkMinutes ?? MIN_TASK_MINUTES;
        return {
          stageId: input.stageId,
          planDate,
          module: input.module,
          skill: input.skill,
          plannedMinutes: input.plannedMinutes,
          actualMinutes: 0,
          sortOrder: sortBase + index,
          track: input.track,
          primarySkill: input.primarySkill,
          priority: input.priority,
          sourceKind: input.sourceKind,
          splittable: input.splittable ?? input.plannedMinutes > minChunkMinutes,
          minChunkMinutes,
          planVersion: version,
          originalScheduledDate: planDate,
          resourceId: input.resourceId ?? null,
          note: input.note ?? null,
          candidateId: input.candidateId ?? null,
          decisionJson: input.decisionJson ?? null,
        };
      }),
      select: { id: true },
    });
    taskIds.push(...rows.map((row) => row.id));

    for (const input of dayInputs) {
      if (!input.proposalItemId) continue;
      const index = dayInputs.indexOf(input);
      await tx.taskProposalItem.update({
        where: { id: input.proposalItemId },
        data: { planTaskId: rows[index].id },
      });
    }

    const activeTasks = await tx.planTask.findMany({
      where: { planDate, status: { notIn: ['CANCELLED', 'DEFERRED'] } },
      select: { id: true },
      orderBy: { sortOrder: 'asc' },
    });
    const plannedMinutesAfter = existingMinutes + addedMinutes;
    const header = await tx.planVersion.create({
      data: {
        planDate,
        version,
        changeSource: audit.changeSource,
        reason: audit.reason,
        budgetMinutes: budget.minutes,
        actualMinutesAtChange: netAgg._sum.minutes ?? 0,
        beforeSnapshot: JSON.stringify({ existingMinutes }),
        afterSnapshot: JSON.stringify({
          taskIds: activeTasks.map((task) => task.id),
          taskCount: activeTasks.length,
          newTaskCount: rows.length,
          totalMinutes: plannedMinutesAfter,
          layer: 'DAY',
        }),
        idempotencyKey: idempotencyKey
          ? (planDate === primaryPlanDate ? idempotencyKey : `${idempotencyKey}:${planDate}`)
          : null,
      },
      select: { id: true },
    });
    versions.push({ planDate, version, id: header.id });
  }
  return { taskIds, versions };
}

export interface UpdatePlanTaskInput {
  taskId: string;
  plannedMinutes?: number;
  resourceId?: string | null;
  note?: string | null;
}

export async function updatePlanTask(
  input: UpdatePlanTaskInput,
): Promise<ActionResult<{ taskId: string; planVersion: number }>> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.planTask.findUnique({ where: { id: input.taskId } });
      if (!task) return { notFound: true as const };

      const minutesChanged =
        input.plannedMinutes !== undefined && input.plannedMinutes !== task.plannedMinutes;
      const data: Prisma.PlanTaskUncheckedUpdateInput = {};
      if (input.plannedMinutes !== undefined) {
        data.plannedMinutes = input.plannedMinutes;
        data.splittable = input.plannedMinutes > (task.minChunkMinutes ?? MIN_TASK_MINUTES);
      }
      if (input.resourceId !== undefined) data.resourceId = input.resourceId;
      if (input.note !== undefined) data.note = input.note;
      if (Object.keys(data).length === 0) {
        return { notFound: false as const, taskId: task.id, planVersion: task.planVersion };
      }

      let version = task.planVersion;
      if (minutesChanged) {
        const existingMinutes = await reservedMinutesOnDate(task.planDate, tx);
        const actualByTask = await effectiveActualMinutesByTask([task], tx);
        const actualMinutes = actualByTask.get(task.id) ?? 0;
        const active = !['CANCELLED', 'DEFERRED'].includes(task.status);
        const oldReserved = active ? reservedMinutesForTask(task, actualMinutes) : 0;
        const newReserved = active
          ? reservedMinutesForTask({ ...task, plannedMinutes: input.plannedMinutes! }, actualMinutes)
          : 0;
        const budget = await getEffectiveBudget(task.planDate, tx);
        const check = validateProposalAgainstBudget(
          [{ date: task.planDate, minutes: existingMinutes - oldReserved + newReserved }],
          [{ date: task.planDate, minutes: budget.minutes, isRestDay: budget.isRestDay }],
        );
        if (!check.ok) throw new BudgetGateError(describeBudgetViolations(check.violations));

        version = await nextPlanVersion(task.planDate, tx);
        data.planVersion = version;
      }

      await tx.planTask.update({ where: { id: task.id }, data });
      if (minutesChanged) {
        const activeTasks = await tx.planTask.findMany({
          where: { planDate: task.planDate, status: { notIn: ['CANCELLED', 'DEFERRED'] } },
          select: { id: true },
          orderBy: { sortOrder: 'asc' },
        });
        const netAgg = await tx.studySessionDaySplit.aggregate({
          where: { date: task.planDate },
          _sum: { minutes: true },
        });
        const budget = await getEffectiveBudget(task.planDate, tx);
        await tx.planVersion.create({
          data: {
            planDate: task.planDate,
            version,
            changeSource: 'MANUAL_ADJUST',
            reason: '手工调整任务时长',
            budgetMinutes: budget.minutes,
            actualMinutesAtChange: netAgg._sum.minutes ?? 0,
            afterSnapshot: JSON.stringify({
              taskIds: activeTasks.map((row) => row.id),
              taskCount: activeTasks.length,
              changedTaskId: task.id,
              totalMinutes: await reservedMinutesOnDate(task.planDate, tx),
              layer: 'DAY',
            }),
          },
        });
      }
      return { notFound: false as const, taskId: task.id, planVersion: version };
    });

    if (result.notFound) return fail('NOT_FOUND', '任务不存在或已被删除');
    return ok({ taskId: result.taskId, planVersion: result.planVersion });
  } catch (error) {
    if (error instanceof BudgetGateError) return fail('PRECONDITION', error.message);
    if (isUniqueConstraintError(error)) return fail('CONFLICT', '计划写入发生并发冲突，请刷新后重试');
    throw error;
  }
}

export async function appendTaskFromCandidate(
  input: AppendTaskFromCandidateInput,
): Promise<ActionResult<AppendTaskFromCandidateResult>> {
  const minChunkMinutes = input.minChunkMinutes ?? MIN_TASK_MINUTES;
  try {
    const result = await prisma.$transaction((tx) =>
      appendTaskFromCandidateInTransaction(tx, input),
    );
    return ok(result);
  } catch (error) {
    if (error instanceof BudgetGateError) return fail('PRECONDITION', error.message);
    if (isUniqueConstraintError(error)) {
      console.error('计划写入唯一约束冲突', { code: 'P2002' });
      if (input.idempotencyKey) {
        const hit = await prisma.planVersion.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { version: true },
        });
        if (hit) {
          const existingTask = await prisma.planTask.findFirst({
            where: { planDate: input.planDate, planVersion: hit.version },
            orderBy: { sortOrder: 'asc' },
            select: { id: true, plannedMinutes: true, splittable: true },
          });
          if (existingTask) {
            const plannedMinutesAfter = await reservedMinutesOnDate(input.planDate, prisma);
            return ok({
              taskId: existingTask.id,
              planVersion: hit.version,
              created: false,
              splittable: existingTask.splittable,
              plannedMinutesAfter,
              warnings: [],
            });
          }
        }
      }
      return fail('CONFLICT', '计划写入发生并发冲突，请刷新后重试');
    }
    throw error;
  }
}

export class BudgetGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetGateError';
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'P2002';
}
