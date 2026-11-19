/**
 * EGIU 单元与复测的 zod 契约。
 *
 * 注意：复测记录是 **append-only**，所以这里只有「新增」schema，
 * 刻意不存在 update / delete schema —— UI 也就没有对应入口。
 */

import { z } from 'zod';
import { REVIEW_STAGE_CODES } from '../constants';
import { dateString, enumFrom, nonNegativeInt, optionalText } from './common';

/** 新建 / 编辑 EGIU 单元（只允许改元数据，不允许手改颜色）。 */
export const upsertEgiuLessonSchema = z.object({
  id: z.string().min(1).optional(),
  stageId: z.string().min(1, '缺少阶段'),
  resourceId: z.union([z.string().min(1), z.literal('')]).optional(),
  book: z.string().trim().min(1, '请填写教材名').max(120, '教材名不超过 120 字'),
  version: optionalText(60),
  unitNo: z.string().trim().min(1, '请填写单元号').max(40, '单元号不超过 40 字'),
  knowledgePoint: z.string().trim().min(1, '请填写知识点').max(200, '知识点不超过 200 字'),
  learnedDate: dateString,
});
export type UpsertEgiuLessonInput = z.infer<typeof upsertEgiuLessonSchema>;

/** 归档（软删除）EGIU 单元。 */
export const archiveEgiuLessonSchema = z.object({
  id: z.string().min(1, '缺少单元 ID'),
});
export type ArchiveEgiuLessonInput = z.infer<typeof archiveEgiuLessonSchema>;

/** 单次复测的错因分布（字段名与 `EgiuReview.errorBreakdown` 的 JSON 键一致）。 */
export const egiuErrorBreakdownSchema = z.object({
  rule_unclear: nonNegativeInt.optional(),
  memory_confusion: nonNegativeInt.optional(),
  careless: nonNegativeInt.optional(),
  vocab: nonNegativeInt.optional(),
});
export type EgiuErrorBreakdownInput = z.infer<typeof egiuErrorBreakdownSchema>;

/**
 * 录入一次 EGIU 复测（首测同样走这张表，`reviewStage = 'D0'`）。
 *
 * 颜色由 `domain/color.ts` 在服务端判定后落库，**客户端不传颜色**。
 */
export const recordEgiuReviewSchema = z
  .object({
    lessonId: z.string().min(1, '缺少单元 ID'),
    reviewDate: dateString,
    reviewStage: enumFrom(REVIEW_STAGE_CODES, '复测档位'),
    totalQuestions: nonNegativeInt,
    correctQuestions: nonNegativeInt,
    explainOk: z.boolean(),
    sentencesCount: nonNegativeInt,
    coreRuleOk: z.boolean(),
    errorBreakdown: egiuErrorBreakdownSchema.optional(),
  })
  .refine((value) => value.correctQuestions <= value.totalQuestions, {
    message: '正确题数不能大于总题数',
    path: ['correctQuestions'],
  })
  .refine((value) => value.totalQuestions > 0 || value.reviewStage === 'D0', {
    message: '题量为 0 只能作为首测记录（D0），复测必须实际做题',
    path: ['totalQuestions'],
  });
export type RecordEgiuReviewInput = z.infer<typeof recordEgiuReviewSchema>;
