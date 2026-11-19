/**
 * 障碍诊断与定向修复的 zod 契约。
 *
 * 关键约束：
 * - 障碍类型必须属于该技能自己的清单（不同技能的障碍不可互换）。
 * - 成功标准必须写成可观察的行为，不能是「多练几次」这类口头目标。
 * - 修复支架不允许 A4（代写/代答）。
 */

import { z } from 'zod';
import {
  ASSISTANCE_LEVELS,
  BARRIER_IMPACT_MIN_CHARS,
  BARRIER_TYPES_BY_SKILL,
  EVIDENCE_CONFIDENCES,
  EVIDENCE_SKILLS,
  INTERVENTION_ACTION_MIN_CHARS,
  INTERVENTION_CRITERIA_MIN_CHARS,
  INTERVENTION_FORBIDDEN_SCAFFOLD,
  INTERVENTION_STATUSES,
} from '../constants';
import type { EvidenceSkill } from '../types';
import { enumFrom, minutesField, optionalId, optionalText } from './common';

export const createBarrierSchema = z
  .object({
    skill: enumFrom(EVIDENCE_SKILLS, '技能'),
    barrierType: z.string().trim().min(1, '请选择障碍类型'),
    evidenceId: optionalId,
    evidenceAnchor: optionalText(300),
    impact: z
      .string()
      .trim()
      .min(BARRIER_IMPACT_MIN_CHARS, `请具体说明影响（至少 ${BARRIER_IMPACT_MIN_CHARS} 字）`)
      .max(1000, '说明过长'),
    confidence: enumFrom(EVIDENCE_CONFIDENCES, '置信度').optional(),
    note: optionalText(1000),
  })
  .superRefine((value, ctx) => {
    const allowed = BARRIER_TYPES_BY_SKILL[value.skill as EvidenceSkill];
    if (!allowed.includes(value.barrierType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['barrierType'],
        message: '该障碍类型不属于所选技能',
      });
    }
  });
export type CreateBarrierInput = z.infer<typeof createBarrierSchema>;

export const upsertInterventionSchema = z
  .object({
    id: optionalId,
    barrierId: z.string().min(1, '缺少障碍 ID'),
    action: z
      .string()
      .trim()
      .min(
        INTERVENTION_ACTION_MIN_CHARS,
        `修复动作请写具体（至少 ${INTERVENTION_ACTION_MIN_CHARS} 字）`,
      )
      .max(1000, '修复动作过长'),
    successCriteria: z
      .string()
      .trim()
      .min(
        INTERVENTION_CRITERIA_MIN_CHARS,
        `成功标准请写成可观察的行为（至少 ${INTERVENTION_CRITERIA_MIN_CHARS} 字）`,
      )
      .max(1000, '成功标准过长'),
    scaffoldLevel: enumFrom(ASSISTANCE_LEVELS, '支架级别').optional(),
    estimatedMinutes: minutesField(5, 120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scaffoldLevel === INTERVENTION_FORBIDDEN_SCAFFOLD) {
      ctx.addIssue({
        code: 'custom',
        path: ['scaffoldLevel'],
        message: 'A4（代写/代答）不能作为修复支架；修复必须由学习者自己完成。',
      });
    }
  });
export type UpsertInterventionInput = z.infer<typeof upsertInterventionSchema>;

export const changeInterventionStatusSchema = z.object({
  id: z.string().min(1, '缺少修复 ID'),
  status: enumFrom(INTERVENTION_STATUSES, '修复状态'),
});
export type ChangeInterventionStatusInput = z.infer<typeof changeInterventionStatusSchema>;

export const linkInterventionEvidenceSchema = z.object({
  id: z.string().min(1, '缺少修复 ID'),
  role: enumFrom(['PRE', 'POST'], '样本角色'),
  evidenceId: z.string().min(1, '请选择证据'),
});
export type LinkInterventionEvidenceInput = z.infer<typeof linkInterventionEvidenceSchema>;

export const barrierIdSchema = z.object({
  id: z.string().min(1, '缺少障碍 ID'),
});
export type BarrierIdInput = z.infer<typeof barrierIdSchema>;

/** 供 UI 预校验：A4 不能当支架。 */
export const FORBIDDEN_SCAFFOLD = INTERVENTION_FORBIDDEN_SCAFFOLD;
