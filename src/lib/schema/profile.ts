/**
 * 分项画像 zod 契约。
 *
 * 方向只是方向性描述（可为空 = 待评估）；不提供任何 CEFR 官方等级换算入口。
 */

import { z } from 'zod';
import {
  EVIDENCE_CONFIDENCES,
  PROFILE_SKILLS,
  SKILL_DIRECTIONS,
} from '../constants';
import { dateString, enumFrom, optionalText } from './common';

export const upsertSkillProfileSchema = z.object({
  skill: enumFrom(PROFILE_SKILLS, '技能'),
  direction: z.union([enumFrom(SKILL_DIRECTIONS, '能力方向'), z.literal('')]).optional(),
  confidence: enumFrom(EVIDENCE_CONFIDENCES, '置信度'),
  evidenceBasis: z.array(z.string().min(1)).max(50, '最多挂 50 条依据').optional(),
  lastAssessedAt: z.union([dateString, z.literal('')]).optional(),
  reviewDueAt: z.union([dateString, z.literal('')]).optional(),
  doNotInfer: optionalText(1000),
  note: optionalText(1000),
});
export type UpsertSkillProfileInput = z.infer<typeof upsertSkillProfileSchema>;
