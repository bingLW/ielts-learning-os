/**
 * 错题本 zod 契约。
 *
 * 6 类错误类别是**必填**（PRD：错题必须归类，否则无法聚合薄弱点）；
 * 雅思 5 类错因只在 S3 启用，因此可选。
 */

import { z } from 'zod';
import {
  BATCH_REVIEW_MAX,
  ERROR_CATEGORIES,
  IELTS_ERROR_CATEGORIES,
  MISTAKE_SOURCES,
} from '../constants';
import { dateString, enumFrom, optionalId, optionalText } from './common';

const mistakeBase = z.object({
  stageId: z.string().min(1, '缺少阶段'),
  sourceType: enumFrom(MISTAKE_SOURCES, '来源'),
  studyRecordId: optionalId,
  originalQuestion: z.string().trim().min(1, '请填写原题').max(4000, '原题不超过 4000 字'),
  myAnswer: optionalText(2000),
  correctAnswer: z.string().trim().min(1, '请填写正确答案').max(2000, '正确答案不超过 2000 字'),
  errorReason: z.string().trim().min(1, '请填写错误原因').max(2000, '错误原因不超过 2000 字'),
  knowledgePoint: z.string().trim().min(1, '请填写知识点').max(120, '知识点不超过 120 字'),
  errorCategory: enumFrom(ERROR_CATEGORIES, '错误类别'),
  ieltsErrorCategory: z.union([enumFrom(IELTS_ERROR_CATEGORIES, '雅思错因'), z.literal('')]).optional(),
  nextReviewAt: z.union([dateString, z.literal('')]).optional(),
});

/** 新建错题。 */
export const createMistakeSchema = mistakeBase;
export type CreateMistakeInput = z.infer<typeof createMistakeSchema>;

/** 编辑错题。 */
export const updateMistakeSchema = mistakeBase.extend({
  id: z.string().min(1, '缺少错题 ID'),
});
export type UpdateMistakeInput = z.infer<typeof updateMistakeSchema>;

/** 标记 / 取消「已掌握」。 */
export const markMistakeMasteredSchema = z.object({
  id: z.string().min(1, '缺少错题 ID'),
  mastered: z.boolean(),
});
export type MarkMistakeMasteredInput = z.infer<typeof markMistakeMasteredSchema>;

/** 归档错题（软删除）。 */
export const archiveMistakeSchema = z.object({
  id: z.string().min(1, '缺少错题 ID'),
});
export type ArchiveMistakeInput = z.infer<typeof archiveMistakeSchema>;

/**
 * 从错题生成复习任务。
 *
 * 复用统一的 `ReviewTask`（`targetType = 'MISTAKE'`），不另建调度器；
 * `intervalCode = 'MANUAL'`，到期日由 action 按业务日期计算。
 */
export const generateMistakeReviewSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, '至少选择一道错题')
    .max(BATCH_REVIEW_MAX, `单次最多 ${BATCH_REVIEW_MAX} 道`),
  /** 首轮复习间隔（天）；不传则用 `REVIEW_INTERVAL_DAYS.MANUAL`。 */
  intervalDays: z.coerce.number().int().min(1).max(30).optional(),
});
export type GenerateMistakeReviewInput = z.infer<typeof generateMistakeReviewSchema>;
