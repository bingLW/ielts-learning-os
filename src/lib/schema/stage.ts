/**
 * 阶段与验收 zod 契约。
 *
 * 关键约束：`verdict !== PENDING` 时「我的实际结果」与「证据」必填 ——
 * 这是 H2 硬条件的前置校验，放在 schema 层可以保证脏数据进不了库。
 */

import { z } from 'zod';
import { TRANSITION_REASON_MIN_LENGTH, VERDICTS } from '../constants';
import { dateString, enumFrom, optionalId, optionalText } from './common';

export const updateAcceptanceItemSchema = z
  .object({
    itemId: z.string().min(1, '缺少验收项 ID'),
    myResult: optionalText(2000),
    evidence: optionalText(1000),
    verdict: enumFrom(VERDICTS, '判定'),
    judgedAt: dateString.optional(),
  })
  .refine(
    (value) =>
      value.verdict === 'PENDING' ||
      ((value.myResult ?? '').trim().length > 0 && (value.evidence ?? '').trim().length > 0),
    {
      message: '判为通过/未通过时必须填写「我的实际结果」与「证据」',
      path: ['myResult'],
    },
  );
export type UpdateAcceptanceItemInput = z.infer<typeof updateAcceptanceItemSchema>;

export const transitionStageSchema = z.object({
  toStageId: z.string().min(1, '缺少目标阶段'),
  reason: z
    .string()
    .trim()
    .min(TRANSITION_REASON_MIN_LENGTH, `升级原因至少 ${TRANSITION_REASON_MIN_LENGTH} 个字`),
  fromStageId: optionalId,
});
export type TransitionStageInput = z.infer<typeof transitionStageSchema>;

export const evaluateGateSchema = z.object({
  stageId: z.string().min(1, '缺少阶段 ID'),
});
export type EvaluateGateInput = z.infer<typeof evaluateGateSchema>;
