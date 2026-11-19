/**
 * 系统设置 zod 契约。
 *
 * 时区不可改（固定 Asia/Singapore），所以这里根本没有 `timezone` 字段 ——
 * 不是「忽略」，而是「客户端无权传」。
 */

import { z } from 'zod';
import { DAILY_MINUTES_MAX, DAILY_MINUTES_MIN } from '../constants';
import { dateString, optionalText } from './common';

/** 0.5 步进的 Band 分。 */
const bandField = z.coerce
  .number()
  .min(0, '不得小于 0')
  .max(9, '不得大于 9')
  .refine((value) => Math.round(value * 2) === value * 2, '必须为 0.5 的整数倍');

export const updateProfileSchema = z.object({
  targetBandOverall: bandField,
  targetBandListen: bandField.optional(),
  targetBandRead: bandField.optional(),
  targetBandWrite: bandField.optional(),
  targetBandSpeak: bandField.optional(),
  dailyMinutes: z.coerce
    .number()
    .int('必须为整数')
    .min(DAILY_MINUTES_MIN, `每日时长不得少于 ${DAILY_MINUTES_MIN} 分钟`)
    .max(DAILY_MINUTES_MAX, `每日时长不得超过 ${DAILY_MINUTES_MAX} 分钟`),
  weeklyReviewDow: z.coerce.number().int().min(0).max(6),
  examDate: z.union([dateString, z.literal('')]).optional(),
  aiEnabled: z.boolean().optional(),
  longTermGoalLabel: optionalText(120),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
