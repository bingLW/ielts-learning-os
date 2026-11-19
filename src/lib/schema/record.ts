/**
 * 学习记录的 zod 契约。
 *
 * 两条硬校验都在 schema 层兜住：
 * 1. `correctQuestions <= totalQuestions`；
 * 2. G2 —— 「产出」与「问题」至少填一项，否则记录不构成学习证据。
 */

import { z } from 'zod';
import {
  DIFFICULTIES,
  LEARNING_TRACKS,
  PRIMARY_SKILLS,
  SKILL_IDS,
  TASK_STATUSES,
} from '../constants';
import { dateString, enumFrom, minutesField, nonNegativeInt, optionalId, optionalText } from './common';

/** 分科扩展字段：只允许可 JSON 化的标量，避免嵌套对象污染。 */
const extValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const recordExtSchema = z.record(z.string(), extValue);
export type RecordExt = z.infer<typeof recordExtSchema>;

const recordBase = z.object({
  stageId: z.string().min(1, '必须指定阶段'),
  taskId: optionalId,
  recordDate: dateString,
  skill: enumFrom(SKILL_IDS, '科目'),
  resourceId: optionalId,
  chapter: optionalText(120),
  content: z.string().trim().min(1, '请填写内容摘要').max(500, '内容摘要不超过 500 字'),
  plannedMinutes: minutesField(0, 600),
  actualMinutes: minutesField(0, 600),
  status: enumFrom(TASK_STATUSES, '状态'),
  totalQuestions: nonNegativeInt,
  correctQuestions: nonNegativeInt,
  difficulty: enumFrom(DIFFICULTIES, '难度').optional(),
  outputText: optionalText(6000),
  problemText: optionalText(6000),
  errorTypes: z.array(z.string().min(1)).max(20).optional(),
  nextReviewDate: dateString.optional(),
  ext: recordExtSchema.optional(),
  // v2.0：轨道与四技能粒度。不传时由 Action 层按 `skill` 推导
  // （`SKILL_TO_PRIMARY` / `SKILL_TRACK`），保证落库快照永不为空。
  track: enumFrom(LEARNING_TRACKS, '轨道').optional(),
  primarySkill: enumFrom(PRIMARY_SKILLS, '四技能').optional(),
});

/** 新建记录。 */
export const createRecordSchema = recordBase
  .refine((value) => value.correctQuestions <= value.totalQuestions, {
    message: '正确数不得大于总题数',
    path: ['correctQuestions'],
  })
  .refine(
    (value) =>
      (value.outputText ?? '').trim().length > 0 || (value.problemText ?? '').trim().length > 0,
    {
      message: '「产出」与「问题」至少填写一项（每次学习必须留下可检查结果）',
      path: ['outputText'],
    },
  );
export type CreateRecordInput = z.infer<typeof createRecordSchema>;

/** 更新记录（字段级修订历史由 Action 层写 `RecordRevision`）。 */
export const updateRecordSchema = recordBase
  .extend({ id: z.string().min(1, '缺少记录 ID') })
  .refine((value) => value.correctQuestions <= value.totalQuestions, {
    message: '正确数不得大于总题数',
    path: ['correctQuestions'],
  })
  .refine(
    (value) =>
      (value.outputText ?? '').trim().length > 0 || (value.problemText ?? '').trim().length > 0,
    {
      message: '「产出」与「问题」至少填写一项（每次学习必须留下可检查结果）',
      path: ['outputText'],
    },
  );
export type UpdateRecordInput = z.infer<typeof updateRecordSchema>;

/** 归档（软删除）。 */
export const archiveRecordSchema = z.object({
  id: z.string().min(1, '缺少记录 ID'),
});
export type ArchiveRecordInput = z.infer<typeof archiveRecordSchema>;
