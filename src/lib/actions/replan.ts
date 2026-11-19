/**
 * v2.1 中途重新规划 Server Actions。
 *
 * 当日预算变更后，如果已有部分学习记录，调用本模块进行重排。
 */

'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { replanDailyTasks, type ExistingTask } from '@/lib/domain/replan';
import { tierCodeOf } from '@/lib/constants';
import { loadPlanEngineContext, nextPlanVersion, primaryResourceMap, SKILL_TO_SUBJECT } from '@/lib/queries/planning';
import { getActiveStage } from '@/lib/queries/stages';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { dateString } from '@/lib/schema/common';
import type { ActionResult } from '@/lib/types';
import { today } from '@/lib/date';

const replanSchema = z.object({
  planDate: dateString,
  /** 客户端持有的事务键：同一次重排请求重放时复用，用于返回已有结果而不是再排一遍。 */
  idempotencyKey: z.string().min(1).max(120).optional(),
  /** 新预算（由外部已调用 setBudgetAction 写入，这里再读一次确保一致性）。 */
  newBudgetMinutes: z.coerce.number().int('必须为整数').min(0, '不得为负数'),
  reason: z.string().max(500, '原因不得超过 500 字').optional(),
});

/**
 * 重新规划当日任务。
 *
 * 前置条件：
 * - 当日必须已有任务（否则直接生成，不需要重排）；
 * - 新预算已通过 `setBudgetAction` 写入 `DailyBudget`。
 *
 * 流程：
 * ① 读取当日所有 PlanTask 及已发生净时长；
 * ② 调用 `replanDailyTasks` 得到处置指令 + 新任务；
 * ③ 在事务内执行所有变更（KEEP 无操作 / SHRINK 更新 / DELETE 删除 / 新任务 createMany）；
 * ④ 写入 PlanVersion 审计记录（before/after 快照 + 预算 + 已发生时长）。
 */
export async function replanDailyTasksAction(
  input: z.infer<typeof replanSchema>,
): Promise<
  ActionResult<{
    keptCount: number;
    shrunkCount: number;
    deletedCount: number;
    newCount: number;
    version: number;
    warnings: string[];
  }>
> {
  const parsed = replanSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);
  const { planDate, newBudgetMinutes, reason, idempotencyKey } = parsed.data;

  // 幂等：同一次重排请求重放 → 返回已有版本，不再执行任何写入
  if (idempotencyKey) {
    const replay = await prisma.planVersion.findUnique({
      where: { idempotencyKey },
      select: { version: true, planDate: true },
    });
    if (replay) {
      if (replay.planDate !== planDate) {
        return fail('CONFLICT', '同一幂等键已用于其他日期，请刷新后重试');
      }
      return ok({
        keptCount: 0,
        shrunkCount: 0,
        deletedCount: 0,
        newCount: 0,
        version: replay.version,
        warnings: ['该重排请求已执行过，本次直接返回已有结果（未重复创建任务）。'],
      });
    }
  }

  // ① 读取现状
  const [existingRows, stage, nextVersion, actualAgg] = await Promise.all([
    prisma.planTask.findMany({
      where: { planDate },
      orderBy: { sortOrder: 'asc' },
    }),
    getActiveStage(),
    nextPlanVersion(planDate),
    prisma.studySessionDaySplit.aggregate({
      where: { date: planDate },
      _sum: { minutes: true },
    }),
  ]);

  if (existingRows.length === 0) {
    return fail('PRECONDITION', '当日尚无任务，请直接生成计划，无需重排');
  }
  if (!stage) {
    return fail('PRECONDITION', '请先在「阶段与验收」页激活一个阶段');
  }

  const existingTasks: ExistingTask[] = existingRows.map((row) => ({
    id: row.id,
    module: row.module,
    skill: row.skill,
    plannedMinutes: row.plannedMinutes,
    actualMinutes: row.actualMinutes,
    status: row.status as ExistingTask['status'],
    priority: row.priority as ExistingTask['priority'],
    sourceKind: row.sourceKind as ExistingTask['sourceKind'],
    splittable: row.splittable,
    minChunkMinutes: row.minChunkMinutes,
    sortOrder: row.sortOrder,
    planVersion: row.planVersion,
    timerRunning: row.timerStatus === 'RUNNING',
    track: row.track,
    primarySkill: row.primarySkill,
    resourceId: row.resourceId,
    note: row.note,
  }));

  const actualMinutes = actualAgg._sum.minutes ?? 0;

  // ② 引擎输入（与生成入口共用同一份装配）。
  //    未开始任务即将被 DEFER，挂在其上的复测会在事务内解除关联；
  //    先把它们放回到期复测输入，否则这部分时间会被漏排。
  const deferrableIds = existingTasks
    .filter((task) => task.status === 'TODO' && task.actualMinutes <= 0)
    .map((task) => task.id);
  const context = await loadPlanEngineContext(planDate, stage, deferrableIds);

  // ③ 调用领域层。
  //    休息日只看本次传入的新预算；不传档次 —— 交给引擎的是「剩余预算」，
  //    它不是任何一个预设档，套用整日档次的模板会分配错位。
  const isRestDay = newBudgetMinutes === 0;
  const result = replanDailyTasks({
    existingTasks,
    newBudgetMinutes,
    isRestDay,
    planInput: context,
    nextVersion,
    actualMinutesToday: actualMinutes,
  });

  if (!result.ok) {
    return fail('VALIDATION', result.error);
  }

  // ④ 快照
  const beforeSnapshot = JSON.stringify(
    existingTasks.map((task) => ({
      id: task.id,
      module: task.module,
      plannedMinutes: task.plannedMinutes,
      actualMinutes: task.actualMinutes,
      status: task.status,
    })),
  );

  // ⑤ 事务内落库
  let keptCount = 0;
  let shrunkCount = 0;
  let deletedCount = 0;

  await prisma.$transaction(async (tx) => {
    // 新预算与重排同一事务落库：重排是按这个分钟数算的，两者必须一致
    const tierCode = isRestDay ? 'REST' : tierCodeOf(newBudgetMinutes);
    const budgetData = {
      plannedAvailableMinutes: newBudgetMinutes,
      budgetType: isRestDay ? 'REST_DAY' : tierCode === 'CUSTOM' ? 'CUSTOM' : 'PRESET',
      tierCode,
      isRestDay,
      isInitialSuggestion: false,
      source: 'USER',
    };
    await tx.dailyBudget.upsert({
      where: { date: planDate },
      update: budgetData,
      create: { date: planDate, ...budgetData },
    });

    // 执行每条指令
    const moduleById = new Map(existingTasks.map((task) => [task.id, task.module]));
    for (const action of result.actions) {
      if (action.type === 'KEEP') {
        keptCount += 1;
      } else if (action.type === 'SHRINK') {
        await tx.planTask.update({
          where: { id: action.taskId },
          data: { plannedMinutes: action.newPlannedMinutes },
        });
        shrunkCount += 1;
      } else if (action.type === 'DEFER') {
        // DEFER：改状态，不删除行（保护 StudySession FK）
        await tx.planTask.update({
          where: { id: action.taskId },
          data: {
            status: 'DEFERRED',
            statusChangedAt: new Date(),
            deferReason: action.reason,
            rescheduleReason: reason ?? '预算变更后重新规划',
          },
        });
        // 复测任务被延期：解除排期关联，让它能重新进入下一次生成/重排
        if (moduleById.get(action.taskId) === 'EVIDENCE_RETEST') {
          await tx.retestSchedule.updateMany({
            where: { planTaskId: action.taskId },
            data: { planTaskId: null },
          });
        }
        deletedCount += 1;
      }
    }

    // 批量创建新任务
    if (result.newTasks.length > 0) {
      const resourceMap = await primaryResourceMap();
      await tx.planTask.createMany({
        data: result.newTasks.map((spec) => ({
          stageId: stage.id,
          planDate,
          module: spec.module,
          skill: spec.skill,
          plannedMinutes: spec.plannedMinutes,
          actualMinutes: 0,
          status: 'TODO',
          sortOrder: spec.sortOrder,
          track: spec.track,
          primarySkill: spec.primarySkill,
          priority: spec.priority,
          sourceKind: spec.sourceKind,
          splittable: spec.splittable,
          minChunkMinutes: spec.minChunkMinutes,
          planVersion: spec.planVersion,
          originalScheduledDate: planDate,
          rescheduleReason: reason ?? '预算变更后重新规划',
          resourceId: SKILL_TO_SUBJECT[spec.skill]
            ? (resourceMap[SKILL_TO_SUBJECT[spec.skill] as string] ?? null)
            : null,
          note: spec.rationale,
        })),
      });

      // v2.2：重排新增的复测任务同样要回写排期关联
      if (result.scheduledRetestIds.length > 0) {
        const retestTask = await tx.planTask.findFirst({
          where: { planDate, planVersion: nextVersion, module: 'EVIDENCE_RETEST' },
          select: { id: true },
        });
        if (retestTask) {
          await tx.retestSchedule.updateMany({
            where: { id: { in: result.scheduledRetestIds }, status: 'PENDING' },
            data: { planTaskId: retestTask.id },
          });
        }
      }
    }

    // 写入审计记录
    const afterSnapshot = JSON.stringify({
      kept: keptCount,
      shrunk: shrunkCount,
      deleted: deletedCount,
      new: result.newTasks.length,
      plannedAfterReplan: result.plannedAfterReplan,
    });

    await tx.planVersion.create({
      data: {
        planDate,
        version: nextVersion,
        changeSource: 'REPLAN',
        reason: reason ?? '预算变更后重新规划',
        budgetMinutes: newBudgetMinutes,
        actualMinutesAtChange: actualMinutes,
        beforeSnapshot,
        afterSnapshot,
        idempotencyKey: idempotencyKey ?? null,
      },
    });
  });

  revalidatePath('/plan');
  revalidatePath('/');
  return ok({
    keptCount,
    shrunkCount,
    deletedCount,
    newCount: result.newTasks.length,
    version: nextVersion,
    warnings: result.warnings,
  });
}

/**
 * 获取当日重排历史（审计用）。
 */
export async function getPlanVersionsAction(
  planDate: string = today(),
): Promise<ActionResult<{ versions: Array<{ version: number; changeSource: string; reason: string | null; budgetMinutes: number; actualMinutesAtChange: number; createdAt: Date }> }>> {
  const versions = await prisma.planVersion.findMany({
    where: { planDate },
    orderBy: { version: 'asc' },
    select: {
      version: true,
      changeSource: true,
      reason: true,
      budgetMinutes: true,
      actualMinutesAtChange: true,
      createdAt: true,
    },
  });
  return ok({ versions });
}
