/**
 * 复测排期操作的 zod 契约。
 *
 * 完成复测不走这里：它复用证据录入契约（createEvidenceSchema.retestScheduleId），
 * 这样技能/阶段/条件校验只维护一份。
 */

import { z } from 'zod';
import { optionalText } from './common';

export const scheduleRetestSchema = z.object({
  evidenceId: z.string().min(1, '缺少证据 ID'),
});
export type ScheduleRetestInput = z.infer<typeof scheduleRetestSchema>;

export const skipRetestSchema = z.object({
  scheduleId: z.string().min(1, '缺少排期 ID'),
  note: optionalText(300),
});
export type SkipRetestInput = z.infer<typeof skipRetestSchema>;

export const addRetestToPlanSchema = z.object({
  scheduleId: z.string().min(1, '缺少排期 ID'),
});
export type AddRetestToPlanInput = z.infer<typeof addRetestToPlanSchema>;
