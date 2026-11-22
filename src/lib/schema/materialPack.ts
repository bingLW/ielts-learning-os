/**
 * 材料包 / 任务草案的入参校验（T13 §6）。
 *
 * 口径与材料域其它 schema 一致：`.strict()`（多余字段报错而不是被静默忽略 ——
 * 悄悄忽略 `finalDate` 这种拼错，会让用户以为改成功了）、错误文案是中文人话、
 * 日期一律 `YYYY-MM-DD` 字符串（`isValidDateString` 同时校验真实日历日）。
 */

import { z } from 'zod';
import { isValidDateString } from '@/lib/date';
import { materialIdSchema } from './material';

/** 业务日期：`YYYY-MM-DD` 且必须是真实存在的日历日。 */
export const businessDateSchema = z
  .string()
  .refine((value) => isValidDateString(value), '日期必须是 YYYY-MM-DD 格式的合法日期');

/** 草案条目的分钟上限（与 `BUDGET_MINUTES_MAX` 同量级，但草案更保守）。 */
export const PROPOSAL_MINUTES_MIN = 15;
export const PROPOSAL_MINUTES_MAX = 240;

/** 构建/重建材料包。 */
export const materialPackBuildSchema = materialIdSchema
  .extend({
    /** true = 清空旧条目重建（同事务）。 */
    rebuild: z.boolean().optional(),
  })
  .strict();
export type MaterialPackBuildInput = z.infer<typeof materialPackBuildSchema>;

/** 生成任务草案。 */
export const taskProposalCreateSchema = materialIdSchema
  .extend({
    /** 草案基准日（从这天起按每日预算往后排）。 */
    baseDate: businessDateSchema,
    /** true = 先把已有 draft 置为 discarded，再生成新的。 */
    force: z.boolean().optional(),
  })
  .strict();
export type TaskProposalCreateInput = z.infer<typeof taskProposalCreateSchema>;

/**
 * 改一条草案条目（F-03：勾选 / 改分钟 / 改日期）。
 *
 * `finalMinutes` 必须是 15 的倍数：草案的粒度就是 15/30/60，
 * 允许 17 分钟等于允许用户造出排不进任何一天的数字。
 */
export const proposalItemUpdateSchema = z
  .object({
    itemId: z.string().min(6, '草案条目 id 不合法').max(64, '草案条目 id 不合法'),
    selected: z.boolean().optional(),
    finalMinutes: z
      .number()
      .int('分钟必须是整数')
      .min(PROPOSAL_MINUTES_MIN, `最少 ${PROPOSAL_MINUTES_MIN} 分钟`)
      .max(PROPOSAL_MINUTES_MAX, `最多 ${PROPOSAL_MINUTES_MAX} 分钟`)
      .refine((value) => value % 15 === 0, '分钟必须是 15 的倍数')
      .optional(),
    finalDate: businessDateSchema.optional(),
  })
  .strict();
export type ProposalItemUpdateInput = z.infer<typeof proposalItemUpdateSchema>;

/** 确认草案（写 PlanTask）。 */
export const taskProposalConfirmSchema = z
  .object({
    proposalId: z.string().min(6, '草案 id 不合法').max(64, '草案 id 不合法'),
  })
  .strict();
export type TaskProposalConfirmInput = z.infer<typeof taskProposalConfirmSchema>;

/** 丢弃草案。 */
export const taskProposalDiscardSchema = taskProposalConfirmSchema;
