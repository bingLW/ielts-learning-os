/**
 * 词汇与抽测 zod 契约。
 *
 * 三档掌握度是**独立取值**，抽测自评也只用这三档 —— 不存在「记住了/没记住」这种二分。
 */

import { z } from 'zod';
import { MASTERY_LEVELS, QUIZ_SIZE, VOCAB_SOURCES } from '../constants';
import { dateString, enumFrom, optionalText } from './common';

const vocabBase = z.object({
  word: z.string().trim().min(1, '请填写单词').max(120, '单词不超过 120 字'),
  phonetic: optionalText(120),
  partOfSpeech: optionalText(40),
  meaningZh: z.string().trim().min(1, '请填写中文释义').max(300, '释义不超过 300 字'),
  meaningEn: optionalText(500),
  collocation: optionalText(300),
  exampleSentence: optionalText(600),
  source: enumFrom(VOCAB_SOURCES, '来源'),
  learnedDate: dateString,
  mastery: enumFrom(MASTERY_LEVELS, '掌握度'),
  nextReviewAt: z.union([dateString, z.literal('')]).optional(),
});

/** 新增单词（`word` 唯一，冲突时 action 返回 CONFLICT）。 */
export const createVocabWordSchema = vocabBase;
export type CreateVocabWordInput = z.infer<typeof createVocabWordSchema>;

/** 编辑单词。 */
export const updateVocabWordSchema = vocabBase.extend({
  id: z.string().min(1, '缺少单词 ID'),
});
export type UpdateVocabWordInput = z.infer<typeof updateVocabWordSchema>;

/** 归档单词（软删除）。 */
export const archiveVocabWordSchema = z.object({
  id: z.string().min(1, '缺少单词 ID'),
});
export type ArchiveVocabWordInput = z.infer<typeof archiveVocabWordSchema>;

/**
 * 提交一次随机抽测。
 *
 * `answers` 至少要 1 条；上限取 `QUIZ_SIZE.MAX`（100），避免一次提交过大。
 */
export const submitVocabQuizSchema = z.object({
  quizDate: dateString,
  answers: z
    .array(
      z.object({
        wordId: z.string().min(1, '缺少单词 ID'),
        selfRating: enumFrom(MASTERY_LEVELS, '自评'),
      }),
    )
    .min(1, '至少自评一个单词')
    .max(QUIZ_SIZE.MAX, `单次抽测最多 ${QUIZ_SIZE.MAX} 个单词`),
  /** 抽测时是否顺带更新单词的 `mastery`（默认 true）。 */
  applyMastery: z.boolean().optional(),
});
export type SubmitVocabQuizInput = z.infer<typeof submitVocabQuizSchema>;
