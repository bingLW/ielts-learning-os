/**
 * 句子成分 zod 契约。
 *
 * 两个独立字段：`component`（S/V/O/C/Adverbial）与 `pos`（词性）。
 * 这里刻意把它们写成两个独立的可选枚举，任何一方缺省都不影响另一方。
 */

import { z } from 'zod';
import {
  PARTS_OF_SPEECH,
  PATTERN_TAGS,
  SENTENCE_COMPONENTS,
  SENTENCE_ERROR_REASON_MIN,
  SENTENCE_MAX_TOKENS,
  SENTENCE_TEXT_MAX,
  SENTENCE_TOKEN_TEXT_MAX,
} from '../constants';
import { dateString, enumFrom, optionalId, optionalText } from './common';

/** 单个 token。成分与词性各查各自集合，互不校验。 */
export const sentenceTokenSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'token 不能为空')
    .max(SENTENCE_TOKEN_TEXT_MAX, `单个 token 不超过 ${SENTENCE_TOKEN_TEXT_MAX} 字符`),
  component: z.union([enumFrom(SENTENCE_COMPONENTS, '句子成分'), z.literal(''), z.null()]).optional(),
  pos: z.union([enumFrom(PARTS_OF_SPEECH, '词性'), z.literal(''), z.null()]).optional(),
});
export type SentenceTokenInput = z.infer<typeof sentenceTokenSchema>;

/** 新建句子分析（追加式，不做原地改写历史）。 */
export const createSentenceSchema = z
  .object({
    stageId: z.string().min(1, '缺少阶段'),
    sentenceEn: z
      .string()
      .trim()
      .min(1, '请填写英文句子')
      .max(SENTENCE_TEXT_MAX, `句子不超过 ${SENTENCE_TEXT_MAX} 字符`),
    sentenceZh: optionalText(SENTENCE_TEXT_MAX),
    tokens: z
      .array(sentenceTokenSchema)
      .min(1, '至少需要一个 token')
      .max(SENTENCE_MAX_TOKENS, `最多 ${SENTENCE_MAX_TOKENS} 个 token`),
    isCorrect: z.boolean(),
    errorReason: optionalText(500),
    patternTag: z.union([enumFrom(PATTERN_TAGS, '句型标签'), z.literal('')]).optional(),
    sentenceDate: dateString,
    sourceRecordId: optionalId,
  })
  .refine(
    (value) =>
      value.isCorrect ||
      (value.errorReason ?? '').trim().length >= SENTENCE_ERROR_REASON_MIN,
    {
      message: '标为「标错」时必须填写错误原因',
      path: ['errorReason'],
    },
  );
export type CreateSentenceInput = z.infer<typeof createSentenceSchema>;

/** 归档句子分析（软删除）。 */
export const archiveSentenceSchema = z.object({
  id: z.string().min(1, '缺少句子 ID'),
});
export type ArchiveSentenceInput = z.infer<typeof archiveSentenceSchema>;
