/**
 * 能力评估录入契约（v2.0 P4）。
 *
 * 两条独立的证据链，结构上互不换算：
 *   - `SkillAssessment`：CEFR 四技能独立评估（自评/测试/外部/AI 估计）；
 *   - `IeltsAssessment`：雅思正式/模考/单项成绩。
 * 前者喂 General English gate，后者喂 IELTS gate；谁也不读谁。
 */

import { z } from 'zod';
import {
  ALLOCATION_SKILLS,
  ASSESSMENT_TYPES,
  ASSESSOR_KINDS,
  CEFR_LEVELS,
  IELTS_TEST_TYPES,
} from '../constants';
import { dateString, enumFrom, optionalId, optionalText } from './common';

/** 新建一条 CEFR 能力评估。 */
export const createSkillAssessmentSchema = z.object({
  skill: enumFrom(ALLOCATION_SKILLS, '技能'),
  cefrLevel: enumFrom(CEFR_LEVELS, 'CEFR 等级'),
  assessmentType: enumFrom(ASSESSMENT_TYPES, '评估方式'),
  score: optionalText(120),
  assessDate: dateString,
  assessor: enumFrom(ASSESSOR_KINDS, '评估者').default('SELF'),
  confidence: z.coerce
    .number()
    .int('置信度必须为整数')
    .min(1, '置信度不得低于 1')
    .max(5, '置信度不得高于 5')
    .default(3),
  evidenceId: optionalId,
  note: optionalText(1000),
});
export type CreateSkillAssessmentInput = z.infer<typeof createSkillAssessmentSchema>;

/** 新建一条雅思成绩。 */
export const createIeltsAssessmentSchema = z.object({
  testDate: dateString,
  testType: enumFrom(IELTS_TEST_TYPES, '考试类型'),
  overallBand: z.coerce
    .number()
    .min(0, '总分不得低于 0')
    .max(9, '总分不得高于 9')
    .refine((v) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-6, '总分必须为 0.5 的倍数'),
  listeningBand: z.coerce.number().min(0).max(9).optional(),
  readingBand: z.coerce.number().min(0).max(9).optional(),
  writingBand: z.coerce.number().min(0).max(9).optional(),
  speakingBand: z.coerce.number().min(0).max(9).optional(),
  source: optionalText(200),
  notes: optionalText(1000),
});
export type CreateIeltsAssessmentInput = z.infer<typeof createIeltsAssessmentSchema>;

/** 删除评估记录的 ID。 */
export const deleteAssessmentSchema = z.object({
  id: z.string().min(1, '缺少记录 ID'),
  kind: z.enum(['SKILL', 'IELTS']),
});
export type DeleteAssessmentInput = z.infer<typeof deleteAssessmentSchema>;
