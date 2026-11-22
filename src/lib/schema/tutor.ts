/**
 * AI Coach 输入契约（客户端可复用）。
 */

import { z } from 'zod';
import {
  AI_ACCEPTED_AIDS,
  AI_CEFR_LEVELS,
  AI_COACH_MODES,
  AI_COACH_SKILLS,
  AI_EVIDENCE_AID_LEVELS,
  AI_FEEDBACK_HELPFULNESS,
} from '@/lib/constants';
import { enumFrom, optionalText } from './common';

export const startAiSessionSchema = z.object({
  mode: enumFrom(AI_COACH_MODES, '教学模式'),
  skill: enumFrom(AI_COACH_SKILLS, '技能'),
  objective: z.string().trim().min(4, '目标至少 4 个字').max(300, '目标不超过 300 字'),
  targetLevel: enumFrom(AI_CEFR_LEVELS, '目标等级').optional(),
  directTeaching: z.boolean().optional(),
  allowedAids: z.array(enumFrom(AI_ACCEPTED_AIDS, '辅助工具')).max(4).optional(),
});
export type StartAiSessionInput = z.infer<typeof startAiSessionSchema>;

export const sessionIdSchema = z.object({
  sessionId: z.string().min(1, '缺少会话 ID'),
});
export type SessionIdInput = z.infer<typeof sessionIdSchema>;

export const submitBaselineSchema = sessionIdSchema.extend({
  text: z.string().trim().min(1, '请先写入你的独立作答').max(8000, '作答不超过 8000 字'),
  clientRequestId: z.string().min(8).max(80),
});
export type SubmitBaselineInput = z.infer<typeof submitBaselineSchema>;

export const requestTurnSchema = sessionIdSchema.extend({
  clientRequestId: z.string().min(8).max(80),
});
export type RequestTurnInput = z.infer<typeof requestTurnSchema>;

export const requestHintSchema = requestTurnSchema.extend({
  level: z.coerce.number().int().min(1).max(3),
});
export type RequestHintInput = z.infer<typeof requestHintSchema>;

export const submitRetestSchema = sessionIdSchema.extend({
  text: z.string().trim().min(1, '请写入复测作答').max(8000, '作答不超过 8000 字'),
  aidLevel: enumFrom(AI_EVIDENCE_AID_LEVELS, '辅助等级').optional(),
  clientRequestId: z.string().min(8).max(80),
});
export type SubmitRetestInput = z.infer<typeof submitRetestSchema>;

export const markTurnFeedbackSchema = sessionIdSchema.extend({
  turnId: z.string().min(1),
  helpfulness: enumFrom(AI_FEEDBACK_HELPFULNESS, '反馈类型'),
  note: optionalText(500),
});
export type MarkTurnFeedbackInput = z.infer<typeof markTurnFeedbackSchema>;

export const promoteDiagnosisSchema = sessionIdSchema.extend({
  knowledgePoint: z.string().trim().min(1, '请填写知识点').max(120),
  originalQuestion: z.string().trim().min(1, '请填写原题').max(1000),
  myAnswer: optionalText(1000),
  correctAnswer: z.string().trim().min(1, '请填写参考答案').max(1000),
  errorReason: z.string().trim().min(1, '请填写错误原因').max(500),
});
export type PromoteDiagnosisInput = z.infer<typeof promoteDiagnosisSchema>;

const explainLanguage = z.enum(['ZH_MIXED', 'ZH', 'EN']);

export const updateAiEngineSettingsSchema = z.object({
  externalAiEnabled: z.boolean(),
  dailyBudgetUsd: z.coerce.number().min(0).max(100),
  monthlyBudgetUsd: z.coerce.number().min(0).max(1000),
  warnPercent: z.coerce.number().int().min(50).max(100),
  directTeachingDefault: z.boolean(),
  explainLanguage,
});
export type UpdateAiEngineSettingsInput = z.infer<typeof updateAiEngineSettingsSchema>;

export const saveProviderCredentialSchema = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .min(1, '请填写 Base URL')
      .max(300, 'Base URL 不超过 300 字符')
      .refine((value) => /^https?:\/\//.test(value), 'Base URL 必须以 http:// 或 https:// 开头'),
    modelName: z.string().trim().min(1, '请填写模型名').max(120, '模型名不超过 120 字符'),
    apiKey: z.string().trim().max(400, 'API Key 不超过 400 字符').optional(),
    clearApiKey: z.boolean().optional(),
  })
  .refine((input) => !input.apiKey || input.apiKey.length === 0 || input.apiKey.length >= 8, {
    message: 'API Key 至少 8 个字符',
    path: ['apiKey'],
  });
export type SaveProviderCredentialInput = z.infer<typeof saveProviderCredentialSchema>;

export const updateAiModelConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(80),
  inputPricePerMtok: z.coerce.number().min(0).max(1000),
  outputPricePerMtok: z.coerce.number().min(0).max(1000),
  active: z.boolean(),
  isDefault: z.boolean(),
});
export type UpdateAiModelConfigInput = z.infer<typeof updateAiModelConfigSchema>;