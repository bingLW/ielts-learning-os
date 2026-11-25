/**
 * v2.7 T08 过载保护落库 —— 把 `carryoverPolicy()` 的裁决写回 `PlanTask`。
 *
 * 不新建表；只改 `PlanTask` 的既有列。每次「移动」都**必须**写非空的
 * `rescheduleReason` / `deferReason`（AC-11 ⑩），保证历史可解释。
 *
 * 与 `replan` 的顺序（T08 风险③）：本服务在 replan **之前**执行；carryover 的产物
 * （滚入今日的任务）会成为 replan 的「当日已有任务」输入，二者不得对同一任务重复 DEFER。
 */

import { prisma } from '@/lib/prisma';
import { ok } from '@/lib/result';
import type { CarryoverResult } from '@/lib/domain/carryover';
import type { ActionResult } from '@/lib/types';

export interface ApplyCarryoverInput {
  /** 滚入目标日（通常为 `asOfDate`）。 */
  targetDate: string;
  decisions: CarryoverResult['decisions'];
}

export interface CarryoverApplyResult {
  promoted: number;
  demoted: number;
  backlogged: number;
  abandoned: number;
}

/**
 * 逐条落库裁决。
 *
 * - `PROMOTE` / `DEMOTE`：滚入目标日，改优先级，写 `movedToDate` / `movedCount`；
 * - `BACKLOG`：`status=DEFERRED`，写 `deferReason` + `rescheduleReason`，`movedCount+1`；
 * - `ABANDON`：`status=CANCELLED`，写 `deferReason` + `rescheduleReason`。
 */
export async function applyCarryover(
  input: ApplyCarryoverInput,
): Promise<ActionResult<CarryoverApplyResult>> {
  let promoted = 0;
  let demoted = 0;
  let backlogged = 0;
  let abandoned = 0;

  for (const decision of input.decisions) {
    const task = await prisma.planTask.findUnique({
      where: { id: decision.taskId },
      select: { id: true, planDate: true, movedCount: true, movedFromDate: true, originalScheduledDate: true },
    });
    if (!task) continue;

    const movedFromDate = task.movedFromDate ?? task.originalScheduledDate ?? task.planDate;
    const verdict = decision.verdict;

    if (verdict.action === 'PROMOTE' || verdict.action === 'DEMOTE') {
      await prisma.planTask.update({
        where: { id: decision.taskId },
        data: {
          planDate: input.targetDate,
          movedToDate: input.targetDate,
          movedFromDate,
          movedCount: task.movedCount + 1,
          priority: verdict.toPriority,
          status: 'TODO',
          rescheduleReason: verdict.reason,
          deferReason: null,
        },
      });
      if (verdict.action === 'PROMOTE') promoted += 1;
      else demoted += 1;
    } else if (verdict.action === 'BACKLOG') {
      await prisma.planTask.update({
        where: { id: decision.taskId },
        data: {
          status: 'DEFERRED',
          statusChangedAt: new Date(),
          movedCount: task.movedCount + 1,
          movedFromDate,
          deferReason: verdict.reason,
          rescheduleReason: verdict.reason,
        },
      });
      backlogged += 1;
    } else {
      await prisma.planTask.update({
        where: { id: decision.taskId },
        data: {
          status: 'CANCELLED',
          statusChangedAt: new Date(),
          deferReason: verdict.reason,
          rescheduleReason: verdict.reason,
        },
      });
      abandoned += 1;
    }
  }

  return ok({ promoted, demoted, backlogged, abandoned });
}
