/**
 * v2.1 预算设定 Server Actions。
 *
 * 预算变更会触发当日计划重新生成（如果当日尚未开始任何学习）。
 */

'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  BUDGET_INITIAL_SUGGESTION,
  BUDGET_MINUTES_MAX,
  BUDGET_MINUTES_MIN,
  tierCodeOf,
} from '@/lib/constants';
import { budgetTypeOf, clampBudgetMinutes } from '@/lib/queries/budget';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { dateString } from '@/lib/schema/common';
import type { ActionResult, BudgetSource } from '@/lib/types';

const setBudgetSchema = z.object({
  date: dateString,
  minutes: z.coerce
    .number()
    .int('必须为整数')
    .min(0, '不得为负数')
    .max(BUDGET_MINUTES_MAX, `不得超过 ${BUDGET_MINUTES_MAX} 分钟`),
  note: z.string().max(500, '备注不得超过 500 字').optional(),
});

export async function setBudgetAction(
  input: z.infer<typeof setBudgetSchema>,
): Promise<ActionResult<{ budgetId: string; replanNeeded: boolean }>> {
  const parsed = setBudgetSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);
  const { date, minutes, note } = parsed.data;

  const clamped = clampBudgetMinutes(minutes);
  if (clamped === null) {
    return fail('VALIDATION', `预算必须在 ${BUDGET_MINUTES_MIN}–${BUDGET_MINUTES_MAX} 分钟之间，或为 0（休息日）`);
  }

  const isRestDay = clamped === 0;
  // 档次只由分钟数决定，不采信客户端传来的 tierCode（否则会出现「90 分钟档 + 75 分钟」的错配）
  const effectiveTier = isRestDay ? 'REST' : tierCodeOf(clamped);
  const budgetType = budgetTypeOf(effectiveTier);
  const source: BudgetSource = 'USER';

  const existing = await prisma.dailyBudget.findUnique({ where: { date } });
  let budgetId: string;
  if (existing) {
    const updated = await prisma.dailyBudget.update({
      where: { id: existing.id },
      data: {
        plannedAvailableMinutes: clamped,
        budgetType,
        tierCode: effectiveTier,
        isRestDay,
        source,
        isInitialSuggestion: false,
        note: note ?? null,
      },
    });
    budgetId = updated.id;
  } else {
    const created = await prisma.dailyBudget.create({
      data: {
        date,
        plannedAvailableMinutes: clamped,
        budgetType,
        tierCode: effectiveTier,
        isRestDay,
        source,
        isInitialSuggestion: false,
        note: note ?? null,
      },
    });
    budgetId = created.id;
  }

  const actualMinutes = await prisma.studySessionDaySplit.aggregate({
    _sum: { minutes: true },
    where: { date },
  });
  const replanNeeded = (actualMinutes._sum.minutes ?? 0) === 0;

  revalidatePath('/plan');
  revalidatePath('/settings');
  revalidatePath('/planner/budget');
  return ok({ budgetId, replanNeeded });
}

const updatePlannerSettingsSchema = z.object({
  defaultDailyMinutes: z.coerce
    .number()
    .int('必须为整数')
    .min(BUDGET_MINUTES_MIN, `不得少于 ${BUDGET_MINUTES_MIN} 分钟`)
    .max(BUDGET_MINUTES_MAX, `不得超过 ${BUDGET_MINUTES_MAX} 分钟`)
    .optional(),
  weekdayProfiles: z
    .array(
      z.coerce
        .number()
        .int('必须为整数')
        .min(0, '不得为负数')
        .max(BUDGET_MINUTES_MAX, `不得超过 ${BUDGET_MINUTES_MAX} 分钟`),
    )
    .length(7, '必须提供 7 个值（周日..周六）')
    .optional(),
  weeklyTargetMinutes: z.coerce
    .number()
    .int('必须为整数')
    .min(0, '不得为负数')
    .nullable()
    .optional(),
});

export async function updatePlannerSettingsAction(
  input: z.infer<typeof updatePlannerSettingsSchema>,
): Promise<ActionResult<void>> {
  const parsed = updatePlannerSettingsSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);
  const { defaultDailyMinutes, weekdayProfiles, weeklyTargetMinutes } = parsed.data;

  const data: Record<string, unknown> = {};
  if (typeof defaultDailyMinutes === 'number') data.defaultDailyMinutes = defaultDailyMinutes;
  if (weekdayProfiles) data.weekdayProfiles = JSON.stringify(weekdayProfiles);
  if (weeklyTargetMinutes !== undefined) data.weeklyTargetMinutes = weeklyTargetMinutes;

  await prisma.plannerSettings.upsert({
    where: { id: 1 },
    update: { ...data, isUserConfirmed: true },
    create: {
      id: 1,
      defaultDailyMinutes: defaultDailyMinutes ?? BUDGET_INITIAL_SUGGESTION,
      weekdayProfiles: JSON.stringify(weekdayProfiles ?? [60, 60, 60, 60, 60, 60, 0]),
      minTaskMinutes: 5,
      weeklyTargetMinutes: weeklyTargetMinutes ?? null,
      priorityPolicy: JSON.stringify({ p0CapRatio: 0.6, coreMinRatio: 0.3 }),
      isUserConfirmed: true,
    },
  });

  revalidatePath('/settings');
  revalidatePath('/plan');
  return ok(undefined);
}

const setWeeklyTargetSchema = z.object({
  weekStart: dateString,
  targetMinutes: z.coerce
    .number()
    .int('必须为整数')
    .min(1, '周目标必须大于 0'),
  note: z.string().max(500, '备注不得超过 500 字').optional(),
});

export async function setWeeklyTargetAction(
  input: z.infer<typeof setWeeklyTargetSchema>,
): Promise<ActionResult<{ weeklyTargetId: string }>> {
  const parsed = setWeeklyTargetSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);
  const { weekStart, targetMinutes, note } = parsed.data;

  const existing = await prisma.weeklyTarget.findUnique({ where: { weekStart } });
  let weeklyTargetId: string;
  if (existing) {
    const updated = await prisma.weeklyTarget.update({
      where: { id: existing.id },
      data: { targetMinutes, note: note ?? null, status: 'ADJUSTED' },
    });
    weeklyTargetId = updated.id;
  } else {
    const created = await prisma.weeklyTarget.create({
      data: {
        weekStart,
        targetMinutes,
        source: 'USER',
        note: note ?? null,
      },
    });
    weeklyTargetId = created.id;
  }

  revalidatePath('/plan');
  revalidatePath('/weekly');
  revalidatePath('/planner/budget');
  return ok({ weeklyTargetId });
}
