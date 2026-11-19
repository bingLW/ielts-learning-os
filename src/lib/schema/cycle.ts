/**
 * 90 天周期与每周复盘 zod 契约。
 *
 * 规则：
 * - 一个周期内每周只有一条主问题记录（`(cycleId, weekIndex)` 唯一，action 用 upsert）；
 * - 标记「已复盘」前必须有输入/输出/反馈/下周决定，校验在 action 层复用 domain 纯函数；
 * - 恢复说明只允许客观原因 + 最小下一步，长度受限，防止写成任务清单。
 */

import { z } from 'zod';
import { CYCLE_WEEKS } from '../constants';
import { dateString, optionalId, optionalText } from './common';

export const cycleIdSchema = z.object({
  cycleId: z.string().min(1, '缺少周期 ID'),
});

export const createCycleSchema = z.object({
  title: z.string().trim().min(2, '周期标题至少 2 字').max(80, '标题不超过 80 字'),
  goal: z.string().trim().min(5, '学习目标至少 5 字').max(400, '目标不超过 400 字'),
  deliverable: optionalText(200),
  startDate: dateString,
});
export type CreateCycleInput = z.infer<typeof createCycleSchema>;

export const saveRecoverySchema = z.object({
  cycleId: z.string().min(1, '缺少周期 ID'),
  recoveryNote: z
    .string()
    .trim()
    .min(4, '请写明客观原因与一个最小下一步')
    .max(300, '恢复说明不超过 300 字'),
});
export type SaveRecoveryInput = z.infer<typeof saveRecoverySchema>;

export const upsertWeeklyFocusSchema = z.object({
  cycleId: z.string().min(1, '缺少周期 ID'),
  weekIndex: z.coerce
    .number()
    .int('周序号必须是整数')
    .min(1, '周序号从 1 开始')
    .max(CYCLE_WEEKS, `周序号不得超过 ${CYCLE_WEEKS}`),
  focusQuestion: z.string().trim().min(4, '主问题至少 4 字').max(200, '主问题不超过 200 字'),
  inputText: optionalText(2000),
  outputText: optionalText(2000),
  feedbackText: optionalText(2000),
  transferEvidenceId: optionalId,
  nextDecision: optionalText(300),
  reviewed: z.boolean().optional(),
});
export type UpsertWeeklyFocusInput = z.infer<typeof upsertWeeklyFocusSchema>;
