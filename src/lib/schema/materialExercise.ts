/**
 * 材料练习域的入参校验（T11）。
 *
 * 四条产品口径写在这里，不在 action 里：
 * 1. **批量操作只做「全采纳 / 全拒绝」**：逐个改状态是单条语义，批量里混进
 *    "需要复核"会让"我批量处理了 40 道"这句话说不清到底发生了什么。
 * 2. **编辑必须至少改一个字段**：提交空编辑等于「我改了」但什么都没变，
 *    审核记录会变成噪音。
 * 3. **退役必须有原因**（≥4 字）：退役是"这道题从现在起不可用"，
 *    没有原因的话三个月后没人知道为什么它消失了。
 * 4. **作答只允许单选一个 key**：本期题型全是客观单选（D-01~D-03）。
 */

import { z } from 'zod';
import {
  MATERIAL_EXERCISE_REVIEW_STATUSES,
  type MaterialExerciseReviewStatus,
} from '@/lib/constants';
import { enumFrom } from './common';

/** 可批量提交的两种裁决（不含 `edited` / `retired`）。 */
export const EXERCISE_BULK_REVIEW_STATUSES: readonly MaterialExerciseReviewStatus[] = [
  'approved',
  'rejected',
];

/** 退役原因最小长度（与 `INTERVENTION_*_MIN_CHARS` 的写法一致）。 */
export const EXERCISE_RETIRE_REASON_MIN = 4;
export const EXERCISE_RETIRE_REASON_MAX = 200;

/** `materialId` 入参（开始生成练习）。 */
export const exerciseGenerationStartSchema = z
  .object({
    materialId: z.string().min(1).max(64),
  })
  .strict();

export type ExerciseGenerationStartInput = z.infer<typeof exerciseGenerationStartSchema>;

/** 编辑后的选项。 */
export const exerciseOptionEditSchema = z
  .object({
    key: z.string().min(1, '选项标号不能为空').max(8),
    text: z.string().min(1, '选项内容不能为空').max(300),
  })
  .strict();

/**
 * 可编辑字段集合。
 *
 * 刻意**不允许**改 `type` / `targetSkill` / `chunkId`：题型与依据段落决定
 * 这道题"是什么"，改它等于换了一道题，应该退役重生成而不是原地改。
 */
export const exerciseEditsSchema = z
  .object({
    prompt: z.string().min(1, '题干不能为空').max(600).optional(),
    options: z.array(exerciseOptionEditSchema).min(3).max(4).optional(),
    correctKey: z.string().min(1).max(8).optional(),
    explanation: z.string().min(1, '解析不能为空').max(600).optional(),
    evidenceQuote: z.string().min(1, '原文依据不能为空').max(400).optional(),
    difficultyEstimate: z.string().max(20).optional(),
    subskill: z.string().max(60).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '没有提交任何修改内容');

export type ExerciseEditsInput = z.infer<typeof exerciseEditsSchema>;

/** 单条裁决（`edits` 只有在需要改内容时才带）。 */
export const exerciseReviewSchema = z
  .object({
    exerciseId: z.string().min(1).max(64),
    reviewStatus: enumFrom(MATERIAL_EXERCISE_REVIEW_STATUSES, '审核状态'),
    /** 编辑后的字段（带上就会重新过一遍自检）。 */
    edits: exerciseEditsSchema.optional(),
  })
  .strict();

export type ExerciseReviewInput = z.infer<typeof exerciseReviewSchema>;

/** 批量裁决（最多 200 条一次，与既有批量栏一致）。 */
export const exerciseBulkReviewSchema = z
  .object({
    materialId: z.string().min(1).max(64),
    ids: z.array(z.string().min(1).max(64)).min(1, '请先选择要处理的题目').max(200),
    reviewStatus: z.enum(['approved', 'rejected']),
  })
  .strict();

export type ExerciseBulkReviewInput = z.infer<typeof exerciseBulkReviewSchema>;

/** 退役。 */
export const exerciseRetireSchema = z
  .object({
    exerciseId: z.string().min(1).max(64),
    reason: z
      .string()
      .min(EXERCISE_RETIRE_REASON_MIN, `请写明退役原因（至少 ${EXERCISE_RETIRE_REASON_MIN} 个字）`)
      .max(EXERCISE_RETIRE_REASON_MAX),
  })
  .strict();

export type ExerciseRetireInput = z.infer<typeof exerciseRetireSchema>;

/** 作答。 */
export const exerciseAttemptSchema = z
  .object({
    exerciseId: z.string().min(1).max(64),
    selectedKey: z.string().min(1, '请选择一个答案').max(8),
    /** 作答耗时（秒）；缺省不记录。 */
    elapsedSec: z.coerce.number().int().min(0).max(24 * 60 * 60).optional(),
  })
  .strict();

export type ExerciseAttemptInput = z.infer<typeof exerciseAttemptSchema>;
