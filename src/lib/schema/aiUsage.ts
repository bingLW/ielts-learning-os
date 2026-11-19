/**
 * AI 使用日志 zod 契约。
 *
 * 只记「用了什么 AI、在哪一层支架、输出有没有被采纳」，
 * 不上传对话原文；引用用简短描述或链接。
 */

import { z } from 'zod';
import {
  ADOPTION_STATUSES,
  AI_ACTION_TYPES,
  ASSISTANCE_LEVELS,
} from '../constants';
import { aiLevelAllowedForAction } from '../domain/coach';
import type { AIActionType, AssistanceLevel } from '../types';
import { enumFrom, optionalId, optionalText } from './common';

export const createAiUsageSchema = z
  .object({
    toolName: z.string().trim().min(1, '请填写工具名称').max(80, '工具名称过长'),
    modelVersion: optionalText(120),
    assistanceLevel: enumFrom(ASSISTANCE_LEVELS, '辅助级别'),
    actionType: enumFrom(AI_ACTION_TYPES, '使用类型'),
    purpose: optionalText(500),
    inputRef: optionalText(500),
    outputRef: optionalText(500),
    adoptedOrRejected: enumFrom(ADOPTION_STATUSES, '采纳情况'),
    evidenceId: optionalId,
  })
  .superRefine((value, ctx) => {
    const check = aiLevelAllowedForAction(
      value.assistanceLevel as AssistanceLevel,
      value.actionType as AIActionType,
    );
    if (!check.ok) {
      ctx.addIssue({ code: 'custom', path: ['assistanceLevel'], message: check.error });
    }
  });
export type CreateAiUsageInput = z.infer<typeof createAiUsageSchema>;
