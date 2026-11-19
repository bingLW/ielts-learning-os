/**
 * AI 建议 zod 契约（P5：本地规则引擎）。
 *
 * 写入路径用于规则引擎落库；`basis` 是**必须落库的字段** —— UI 要能回答「这条建议依据什么」。
 */

import { z } from 'zod';
import { AI_SCOPES, AI_STATUSES } from '../constants';
import { enumFrom, optionalText } from './common';

/** 写入一条 AI 建议。 */
export const upsertAiSuggestionSchema = z.object({
  scope: enumFrom(AI_SCOPES, '作用域'),
  refKey: optionalText(120),
  status: enumFrom(AI_STATUSES, '状态').optional(),
  title: z.string().trim().min(1, '请填写标题').max(200, '标题不超过 200 字'),
  body: z.string().trim().min(1, '请填写正文').max(8000, '正文不超过 8000 字'),
  basis: optionalText(4000),
  provider: optionalText(60),
});
export type UpsertAiSuggestionInput = z.infer<typeof upsertAiSuggestionSchema>;

/** 请求生成某作用域的建议。 */
export const requestAiAnalysisSchema = z.object({
  scope: enumFrom(AI_SCOPES, '作用域'),
});
export type RequestAiAnalysisInput = z.infer<typeof requestAiAnalysisSchema>;
