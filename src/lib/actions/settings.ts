'use server';

/**
 * 系统设置 Server Actions。
 *
 * 时区只接受 IANA 名称，长期目标标签目前也不落库 ——
 * 它属于产品文案，不进入业务数据，避免与 CEFR 声明混淆。
 */

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { updateProfileSchema } from '@/lib/schema/settings';
import type { ActionResult } from '@/lib/types';

/** 更新学习目标与可用时长。 */
export async function updateProfileAction(
  raw: unknown,
): Promise<
  ActionResult<{
    targetBandOverall: number;
    dailyMinutes: number;
    weeklyReviewDow: number;
    timezone: string;
    examDate: string | null;
    aiEnabled: boolean;
  }>
> {
  const parsed = updateProfileSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const input = parsed.data;
  const data = {
    targetBandOverall: input.targetBandOverall,
    targetBandListen: input.targetBandListen ?? null,
    targetBandRead: input.targetBandRead ?? null,
    targetBandWrite: input.targetBandWrite ?? null,
    targetBandSpeak: input.targetBandSpeak ?? null,
    dailyMinutes: input.dailyMinutes,
    weeklyReviewDow: input.weeklyReviewDow,
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    examDate: nullIfEmpty(input.examDate),
    aiEnabled: input.aiEnabled ?? false,
  };

  const profile = await prisma.userProfile.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data,
  });

  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath('/plan');
  return ok({
    targetBandOverall: profile.targetBandOverall,
    dailyMinutes: profile.dailyMinutes,
    weeklyReviewDow: profile.weeklyReviewDow,
    timezone: profile.timezone,
    examDate: profile.examDate,
    aiEnabled: profile.aiEnabled,
  });
}
