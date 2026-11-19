'use server';

/**
 * 任务状态流转 / 顺延 / 当日总结的 Server Actions。
 *
 * 关键取舍：
 * - `DONE` 是终态，`TASK_TRANSITIONS` 白名单里没有回退路径（PRD P0-05）；
 * - 顺延会**新建语义**（保留原行、改 planDate 并留 moved 痕迹），历史不被篡改；
 * - 顺延次数上限 2，超出提示「该模块连续滞后，建议下调计划时长」。
 */

import { revalidatePath } from 'next/cache';
import { MAX_MOVE_COUNT, TASK_TRANSITIONS } from '@/lib/constants';
import { completionRate } from '@/lib/domain/completion';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import {
  dailySummarySchema,
  finishTaskSchema,
  moveTaskSchema,
  patchTaskStatusSchema,
} from '@/lib/schema/plan';
import { closeRunningSession } from '@/lib/services/timerService';
import type { ActionResult, TaskStatus } from '@/lib/types';
import { getNetMinutesOfDate } from '@/lib/queries/plan';

/** 完成 / 部分完成 / 标记未完成。 */
export async function finishTaskAction(
  raw: unknown,
): Promise<ActionResult<{ taskId: string; status: TaskStatus; actualMinutes: number }>> {
  const parsed = finishTaskSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const task = await prisma.planTask.findUnique({ where: { id: parsed.data.taskId } });
  if (!task) return fail('NOT_FOUND', '任务不存在或已被删除');

  // 若仍在计时，先按当前版本正常收尾，避免丢失这段时长
  if (task.timerStatus === 'RUNNING') {
    const closed = await closeRunningSession(task.id, task.timerVersion, 'COMPLETED');
    if (!closed.ok) return fail(closed.code, closed.error);
  }

  const current = task.status as TaskStatus;
  const allowed = TASK_TRANSITIONS[current] ?? [];
  const target = parsed.data.outcome as TaskStatus;
  if (current !== target && !allowed.includes(target)) {
    return fail('PRECONDITION', `不允许从「${current}」直接改为「${target}」`);
  }

  const actualMinutes =
    parsed.data.actualMinutes !== undefined ? parsed.data.actualMinutes : undefined;

  const updated = await prisma.planTask.update({
    where: { id: task.id },
    data: {
      status: target,
      statusChangedAt: new Date(),
      ...(actualMinutes !== undefined ? { actualMinutes } : {}),
      ...(parsed.data.missReason?.trim() && target === 'MISSED'
        ? { note: `未完成原因：${parsed.data.missReason.trim()}` }
        : {}),
      ...(target === 'DEFERRED'
        ? { deferReason: parsed.data.missReason?.trim() || '预算不足，主动延期' }
        : {}),
    },
  });

  revalidatePath('/plan');
  revalidatePath('/');
  revalidatePath('/records');
  return ok({ taskId: updated.id, status: target, actualMinutes: updated.actualMinutes });
}

/** 状态流转（含非法流转拦截）。 */
export async function patchTaskStatusAction(
  raw: unknown,
): Promise<ActionResult<{ status: TaskStatus; statusChangedAt: string | null }>> {
  const parsed = patchTaskStatusSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const task = await prisma.planTask.findUnique({ where: { id: parsed.data.taskId } });
  if (!task) return fail('NOT_FOUND', '任务不存在或已被删除');

  const current = task.status as TaskStatus;
  const target = parsed.data.to;
  if (current === target) {
    return ok({
      status: current,
      statusChangedAt: task.statusChangedAt ? task.statusChangedAt.toISOString() : null,
    });
  }
  const allowed = TASK_TRANSITIONS[current] ?? [];
  if (!allowed.includes(target)) {
    return fail('PRECONDITION', `非法流转：不允许从「${current}」改为「${target}」`);
  }
  if (task.timerStatus === 'RUNNING' && target !== 'IN_PROGRESS') {
    const closed = await closeRunningSession(task.id, task.timerVersion, 'COMPLETED');
    if (!closed.ok) return fail(closed.code, closed.error);
  }

  const now = new Date();
  await prisma.planTask.update({
    where: { id: task.id },
    data: { status: target, statusChangedAt: now },
  });

  revalidatePath('/plan');
  revalidatePath('/');
  return ok({ status: target, statusChangedAt: now.toISOString() });
}

/** 顺延到目标日期。 */
export async function moveTaskToDateAction(
  raw: unknown,
): Promise<ActionResult<{ movedToDate: string; movedCount: number }>> {
  const parsed = moveTaskSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const task = await prisma.planTask.findUnique({ where: { id: parsed.data.taskId } });
  if (!task) return fail('NOT_FOUND', '任务不存在或已被删除');
  if (task.planDate === parsed.data.targetDate) {
    return fail('PRECONDITION', '目标日期与当前日期相同');
  }
  if (task.movedCount >= MAX_MOVE_COUNT) {
    return fail(
      'PRECONDITION',
      `该任务已顺延 ${task.movedCount} 次，超过上限；建议下调该模块的计划时长`,
    );
  }

  if (task.timerStatus === 'RUNNING') {
    const closed = await closeRunningSession(task.id, task.timerVersion, 'MOVED');
    if (!closed.ok) return fail(closed.code, closed.error);
  }

  const maxSort = await prisma.planTask.aggregate({
    where: { planDate: parsed.data.targetDate },
    _max: { sortOrder: true },
  });

  await prisma.planTask.update({
    where: { id: task.id },
    data: {
      planDate: parsed.data.targetDate,
      movedFromDate: task.planDate,
      movedToDate: parsed.data.targetDate,
      movedCount: task.movedCount + 1,
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      status: 'TODO',
      statusChangedAt: new Date(),
    },
  });

  revalidatePath('/plan');
  revalidatePath('/');
  return ok({ movedToDate: parsed.data.targetDate, movedCount: task.movedCount + 1 });
}

/** 当日总结（草稿）。净值与完成率重新聚合后落库，不允许前端传数值。 */
export async function upsertDailySummaryAction(
  raw: unknown,
): Promise<
  ActionResult<{
    summaryDate: string;
    netMinutes: number;
    completionRateByTime: number | null;
    completionRateByCount: number | null;
  }>
> {
  const parsed = dailySummarySchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { summaryDate, draftText } = parsed.data;

  const [tasks, netMinutes, records] = await Promise.all([
    prisma.planTask.findMany({
      where: { planDate: summaryDate },
      select: {
        plannedMinutes: true,
        actualMinutes: true,
        status: true,
        // 与计划页保持同一口径：已顺延离开本日的任务不进分母（见 domain/completion.ts）
        movedFromDate: true,
      },
    }),
    getNetMinutesOfDate(summaryDate),
    prisma.studyRecord.findMany({
      where: { recordDate: summaryDate, archivedAt: null },
      select: { content: true, outputText: true, problemText: true },
    }),
  ]);

  const completion = completionRate(
    tasks.map((task) => ({
      plannedMinutes: task.plannedMinutes,
      actualMinutes: task.actualMinutes,
      status: task.status as TaskStatus,
      movedFromDate: task.movedFromDate,
    })),
    summaryDate,
  );

  const outputs = records
    .map((record) => (record.outputText ?? '').trim())
    .filter((text) => text.length > 0);
  const issues = records
    .map((record) => (record.problemText ?? '').trim())
    .filter((text) => text.length > 0);

  const data = {
    netMinutes,
    completionRateByTime: completion.byTime,
    completionRateByCount: completion.byCount,
    outputs: stringify(outputs),
    issues: stringify(issues),
    draftText: draftText?.trim() ? draftText.trim() : null,
  };

  const summary = await prisma.dailySummary.upsert({
    where: { summaryDate },
    create: { summaryDate, ...data },
    update: data,
  });

  revalidatePath('/plan');
  revalidatePath('/');
  return ok({
    summaryDate: summary.summaryDate,
    netMinutes: summary.netMinutes,
    completionRateByTime: summary.completionRateByTime,
    completionRateByCount: summary.completionRateByCount,
  });
}
