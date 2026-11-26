'use server';

import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { dateString } from '@/lib/schema/common';
import { resolveBusinessDate } from '@/lib/businessTime';
import type { ActionResult } from '@/lib/types';
import { z } from 'zod';

const replanSchema = z.object({
  planDate: dateString,
  idempotencyKey: z.string().min(1).max(120).optional(),
  newBudgetMinutes: z.coerce.number().int('必须为整数').min(0, '不得为负数'),
  reason: z.string().max(500, '原因不得超过 500 字').optional(),
});

/** Legacy v2.1 重排入口：保留签名，但禁止绕过统一 Planner 的预算、库存和版本守卫。 */
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
  return fail('PRECONDITION', '旧重排入口已停用，请使用 /planner/replan 预览并确认正式计划');
}

/** 获取当日重排历史（审计用）。 */
export async function getPlanVersionsAction(
  planDateParam?: string,
): Promise<ActionResult<{ versions: Array<{ version: number; changeSource: string; reason: string | null; budgetMinutes: number; actualMinutesAtChange: number; createdAt: Date }> }>> {
  const planDate = await resolveBusinessDate(planDateParam);
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
