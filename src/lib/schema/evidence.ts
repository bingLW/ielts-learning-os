/**
 * 证据录入 zod 契约（服务端与客户端共用）。
 *
 * 关键约束：
 * - 基线（BASELINE）必须 A0；辅助版本（ASSISTED）必须 A1–A4。
 * - 给分必须写理由；A0 才能给 2 分。
 * - 至少留下一个可见产出：outputText 或附件 fileUri。
 * - 原始样本不提供「编辑」入口：修订 = 新建记录并挂 parentEvidenceId。
 */

import { z } from 'zod';
import {
  ASSESSOR_TYPES,
  ASSISTANCE_LEVELS,
  EVIDENCE_CONFIDENCES,
  EVIDENCE_LEVELS,
  EVIDENCE_PRIVACY_LEVELS,
  EVIDENCE_SCORE_MAX,
  EVIDENCE_SCORE_MIN,
  EVIDENCE_SKILLS,
  LEARNING_EVIDENCE_TYPES,
} from '../constants';
import { checkTypeAssistance, isIndependent } from '../domain/evidence';
import type { AssistanceLevel, LearningEvidenceType } from '../types';
import { dateString, enumFrom, optionalId, optionalText } from './common';

export const evidenceAttachmentInputSchema = z.object({
  fileUri: z.string().trim().min(1, '附件地址不能为空').max(2000, '地址过长'),
  mimeType: optionalText(120),
  /** v2.0 附件类型：录音 / 作文 / 评分单 / 课程材料 / 截图 / 其他。 */
  evidenceType: enumFrom(
    ['RECORDING', 'WRITING', 'SCORE_SHEET', 'COURSE_MATERIAL', 'SCREENSHOT', 'OTHER'],
    '附件类型',
  ),
  sizeBytes: z.coerce.number().int().min(0).max(2_000_000_000).optional(),
  checksum: optionalText(128),
  privacyLevel: enumFrom(EVIDENCE_PRIVACY_LEVELS, '附件隐私等级').optional(),
  consentStatus: enumFrom(['NOT_REQUIRED', 'GRANTED', 'DENIED'], '外发同意状态').optional(),
  note: optionalText(500),
});
export type EvidenceAttachmentInput = z.infer<typeof evidenceAttachmentInputSchema>;

export const evidenceConditionInputSchema = z.object({
  prompt: optionalText(1000),
  materialSource: optionalText(300),
  timeLimitMinutes: z.coerce.number().int().min(0).max(600).optional(),
  toolsAllowed: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  audience: optionalText(200),
  environment: optionalText(200),
});
export type EvidenceConditionInput = z.infer<typeof evidenceConditionInputSchema>;

export const createEvidenceSchema = z
  .object({
    skill: enumFrom(EVIDENCE_SKILLS, '技能'),
    evidenceType: enumFrom(LEARNING_EVIDENCE_TYPES, '证据类型'),
    level: enumFrom(EVIDENCE_LEVELS, '记录级别').optional(),
    parentEvidenceId: optionalId,
    taskId: optionalId,
    sessionId: optionalId,
    mediatedId: optionalId,
    condition: evidenceConditionInputSchema.optional(),
    outputText: optionalText(20000),
    score: z.coerce
      .number()
      .int('评分必须为整数')
      .min(EVIDENCE_SCORE_MIN, `评分不得小于 ${EVIDENCE_SCORE_MIN}`)
      .max(EVIDENCE_SCORE_MAX, `评分不得大于 ${EVIDENCE_SCORE_MAX}`)
      .optional(),
    scoreReason: optionalText(1000),
    dimensions: z
      .record(z.string().min(1).max(60), z.coerce.number().int().min(0).max(2))
      .optional(),
    evidenceAnchor: optionalText(300),
    assistanceLevel: enumFrom(ASSISTANCE_LEVELS, '辅助级别').optional(),
    assessorType: enumFrom(ASSESSOR_TYPES, '评估者').optional(),
    confidence: enumFrom(EVIDENCE_CONFIDENCES, '置信度').optional(),
    privacyLevel: enumFrom(EVIDENCE_PRIVACY_LEVELS, '隐私等级').optional(),
    note: optionalText(1000),
    /** 只在「补录历史样本」时传；正常录入一律用服务器当前时刻。 */
    createdAtDate: z.union([dateString, z.literal('')]).optional(),
    /** 从复测队列进入时传：保存成功后把对应排期标记为已完成。 */
    retestScheduleId: optionalId,
    attachment: evidenceAttachmentInputSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const assistance: AssistanceLevel = value.assistanceLevel ?? 'A0';
    const typeCheck = checkTypeAssistance(value.evidenceType as LearningEvidenceType, assistance);
    if (!typeCheck.ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['assistanceLevel'],
        message: typeCheck.error,
      });
    }

    const hasOutput = (value.outputText ?? '').trim().length > 0;
    const hasAttachment = Boolean(value.attachment?.fileUri);
    if (!hasOutput && !hasAttachment) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputText'],
        message: '至少留下一个可见产出：正文或附件。',
      });
    }

    if (value.score !== undefined && !(value.scoreReason ?? '').trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoreReason'],
        message: '给出评分时必须写明理由与证据位置。',
      });
    }

    if (value.score !== undefined && value.score >= EVIDENCE_SCORE_MAX && !isIndependent(assistance)) {
      ctx.addIssue({
        code: 'custom',
        path: ['score'],
        message: '2 分只用于无辅助（A0）独立完成；有辅助的样本最高 1 分。',
      });
    }

    if (value.evidenceType === 'BASELINE' && value.parentEvidenceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['parentEvidenceId'],
        message: '基线是证据链起点，不能挂在其他证据之后。',
      });
    }
  });
export type CreateEvidenceInput = z.infer<typeof createEvidenceSchema>;

export const archiveEvidenceSchema = z.object({
  id: z.string().min(1, '缺少证据 ID'),
});
export type ArchiveEvidenceInput = z.infer<typeof archiveEvidenceSchema>;
