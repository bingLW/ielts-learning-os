'use server';

/**
 * 复习中心 Server Actions（T24 / T28 的写入侧）。
 *
 * 关键口径：**逾期不改期**。
 * - 完成：只补 `status/result/completedAt`，`dueDate` 原样保留（留痕「这条当年逾期 3 天」）；
 * - 延期：原记录置 `SKIPPED` 并留原因，另追加一条新的 `MANUAL` 点 —— 历史不被改写；
 * - 跳过：置 `SKIPPED` + 原因，同样不动 `dueDate`。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { BATCH_REVIEW_MAX, BATCH_REVIEW_OPS, REVIEW_INTERVAL_DAYS, REVIEW_RESULTS } from '@/lib/constants';
import { addDays, today } from '@/lib/date';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { enumFrom } from '@/lib/schema/common';
import type { ActionResult, ReviewResult } from '@/lib/types';

const completeSchema = z.object({
  id: z.string().min(1, '缺少复习任务 ID'),
  result: enumFrom(REVIEW_RESULTS, '结果'),
});

const skipSchema = z.object({
  id: z.string().min(1, '缺少复习任务 ID'),
  reason: z.string().trim().max(200, '原因不超过 200 字').optional(),
});

const batchSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, '至少选择一条复习任务')
    .max(BATCH_REVIEW_MAX, `单次最多 ${BATCH_REVIEW_MAX} 条`),
  op: enumFrom(BATCH_REVIEW_OPS, '批量操作'),
});

/** 统一刷新受影响的路径。 */
function revalidateReviewPaths(): void {
  revalidatePath('/review');
  revalidatePath('/mistakes');
  revalidatePath('/grammar');
  revalidatePath('/vocabulary');
  revalidatePath('/');
  revalidatePath('/weekly');
}

/** 完成一条复习任务（通过 / 未通过）。 */
export async function completeReviewTaskAction(
  raw: unknown,
): Promise<ActionResult<{ id: string; result: ReviewResult }>> {
  const parsed = completeSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const task = await prisma.reviewTask.findUnique({ where: { id: parsed.data.id } });
  if (!task) return fail('NOT_FOUND', '复习任务不存在');
  if (task.status !== 'PENDING') return fail('PRECONDITION', '该复习任务已完成或已跳过');

  await prisma.reviewTask.update({
    where: { id: task.id },
    data: {
      status: 'DONE',
      result: parsed.data.result,
      completedAt: new Date(),
      // dueDate 保持原值：逾期事实必须留痕，不允许「完成后自动改期」
    },
  });

  revalidateReviewPaths();
  return ok({ id: task.id, result: parsed.data.result });
}

/** 跳过一条复习任务（保留原因，dueDate 不变）。 */
export async function skipReviewTaskAction(
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = skipSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const task = await prisma.reviewTask.findUnique({ where: { id: parsed.data.id } });
  if (!task) return fail('NOT_FOUND', '复习任务不存在');
  if (task.status !== 'PENDING') return fail('PRECONDITION', '该复习任务已完成或已跳过');

  await prisma.reviewTask.update({
    where: { id: task.id },
    data: {
      status: 'SKIPPED',
      skippedReason: parsed.data.reason?.trim() || '用户手动跳过',
    },
  });

  revalidateReviewPaths();
  return ok({ id: task.id });
}

/**
 * 延期：不改原记录的 dueDate，而是「跳过旧的 + 追加一条新点」。
 *
 * @returns 新点的到期日
 */
async function postponeOne(taskId: string): Promise<
  { ok: true; dueDate: string } | { ok: false; error: string }
> {
  const task = await prisma.reviewTask.findUnique({ where: { id: taskId } });
  if (!task) return { ok: false, error: '复习任务不存在' };
  if (task.status !== 'PENDING') return { ok: false, error: '该复习任务已完成或已跳过' };

  const dueDate = addDays(today(), REVIEW_INTERVAL_DAYS.MANUAL);

  await prisma.$transaction(async (tx) => {
    await tx.reviewTask.update({
      where: { id: task.id },
      data: {
        status: 'SKIPPED',
        skippedReason: `用户延期至 ${dueDate}（原到期日 ${task.dueDate} 保持不变）`,
      },
    });

    const duplicate = await tx.reviewTask.findFirst({
      where: {
        targetType: task.targetType,
        targetId: task.targetId,
        intervalCode: 'MANUAL',
        dueDate,
      },
      select: { id: true },
    });
    if (duplicate) return;

    await tx.reviewTask.create({
      data: {
        targetType: task.targetType,
        targetId: task.targetId,
        targetLabel: task.targetLabel,
        knowledgePoint: task.knowledgePoint,
        intervalCode: 'MANUAL',
        dueDate,
        estMinutes: task.estMinutes,
      },
    });
  });

  return { ok: true, dueDate };
}

/** 单条延期。 */
export async function postponeReviewTaskAction(
  raw: unknown,
): Promise<ActionResult<{ dueDate: string }>> {
  const parsed = z.object({ id: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await postponeOne(parsed.data.id);
  if (!result.ok) return fail('PRECONDITION', result.error);

  revalidateReviewPaths();
  return ok({ dueDate: result.dueDate });
}

/**
 * 批量操作。
 *
 * - `COMPLETE_PASS`：一次性标记为「已通过」；
 * - `POSTPONE`：逐条延期（跳过旧的 + 追加新点）。
 */
export async function batchReviewAction(
  raw: unknown,
): Promise<ActionResult<{ affected: number; op: string }>> {
  const parsed = batchSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { ids, op } = parsed.data;

  if (op === 'COMPLETE_PASS') {
    const result = await prisma.reviewTask.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: { status: 'DONE', result: 'PASS', completedAt: new Date() },
    });
    revalidateReviewPaths();
    return ok({ affected: result.count, op });
  }

  let affected = 0;
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop -- 逐条延期需要独立事务，避免互相覆盖
    const outcome = await postponeOne(id);
    if (outcome.ok) affected += 1;
  }
  revalidateReviewPaths();
  return ok({ affected, op });
}
