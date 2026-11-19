/**
 * v2.3 词汇集成 zod 契约。
 *
 * 导入文本的大小在 schema 层就限制（8MB），避免把超大文件送进解析器再报错。
 */

import { z } from 'zod';
import {
  VOCAB_DIMENSIONS,
  VOCAB_IMPORT_MAX_BYTES,
  VOCAB_PRACTICE_MODES,
  VOCAB_SESSION_GRANULARITIES,
} from '../constants';
import { dateString, isoDateTimeString, optionalText } from './common';

export const vocabImportPreviewSchema = z.object({
  fileName: z.string().trim().min(1, '缺少文件名').max(200),
  text: z
    .string()
    .min(1, '文件为空')
    .max(VOCAB_IMPORT_MAX_BYTES, '文件超过 8MB，请拆分后再导入'),
});
export type VocabImportPreviewInput = z.infer<typeof vocabImportPreviewSchema>;

export const vocabImportCommitSchema = vocabImportPreviewSchema.extend({
  /** 冲突行是否以文件为准更新释义（默认 false = 跳过冲突）。 */
  includeConflicts: z.boolean().default(false),
  /** 导入到哪个词库；为空则新建。 */
  deckId: z.string().trim().optional(),
  deckTitle: z.string().trim().min(1, '请填写词库名称').max(80).optional(),
  deckNote: optionalText(500),
  /** 新词库的阶段标签（可选）。 */
  targetStage: optionalText(40),
});
export type VocabImportCommitInput = z.infer<typeof vocabImportCommitSchema>;

export const createVocabDeckSchema = z.object({
  title: z.string().trim().min(1, '请填写词库名称').max(80),
  targetStage: optionalText(40),
  dailyNewTarget: z.coerce.number().int().min(0).max(100).default(10),
  reviewCap: z.coerce.number().int().min(0).max(200).default(40),
  note: optionalText(500),
});
export type CreateVocabDeckInput = z.infer<typeof createVocabDeckSchema>;

export const exportVocabDeckSchema = z.object({
  deckId: z.string().trim().min(1, '缺少词库 ID'),
});
export type ExportVocabDeckInput = z.infer<typeof exportVocabDeckSchema>;

export const importTypeWordsBackupSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(VOCAB_IMPORT_MAX_BYTES, '备份超过 8MB'),
  /** 是否把汇总会话计入学习时长（默认 true）。 */
  countTime: z.boolean().default(true),
});
export type ImportTypeWordsBackupInput = z.infer<typeof importTypeWordsBackupSchema>;

/** 逐词尝试包（TypeWords 固定版本不产出，但 OS 接受该格式，供未来或手工导入）。 */
export const attemptPackageSchema = z.object({
  provider: z.literal('TYPEWORDS').default('TYPEWORDS'),
  schemaVersion: z.literal(1).default(1),
  sessions: z
    .array(
      z.object({
        externalSessionId: z.string().trim().min(1).max(200),
        startedAt: isoDateTimeString,
        endedAt: isoDateTimeString,
        mode: z.enum(VOCAB_PRACTICE_MODES).optional(),
        deckExternalId: optionalText(200),
        attempts: z
          .array(
            z.object({
              externalAttemptId: z.string().trim().min(1).max(200),
              externalWordId: optionalText(200),
              lemma: optionalText(120),
              occurredAt: isoDateTimeString.optional(),
              mode: z.enum(VOCAB_PRACTICE_MODES).optional(),
              result: z.enum(['CORRECT', 'INCORRECT', 'SKIPPED']),
              latencyMs: z.number().int().min(0).max(600_000).optional(),
              typedInput: optionalText(200),
            }),
          )
          .max(2000, '单个会话最多 2000 条尝试'),
      }),
    )
    .min(1, '至少一条会话')
    .max(200, '单次最多导入 200 个会话'),
});
export type AttemptPackageInput = z.infer<typeof attemptPackageSchema>;

export const createVocabEvidenceSchema = z.object({
  itemId: z.string().trim().min(1, '缺少词条 ID'),
  sessionId: z.string().trim().optional(),
  dimension: z.enum(VOCAB_DIMENSIONS),
  level: z.enum(['QUICK', 'STANDARD', 'FULL']).default('QUICK'),
  score: z.coerce.number().int().min(0).max(2),
  scoreReason: optionalText(500),
  /** 逐词尝试的输入（可选）：用于把维度从「能识别」推进到「能回忆」。 */
  typedInput: optionalText(200),
  note: optionalText(500),
});
export type CreateVocabEvidenceInput = z.infer<typeof createVocabEvidenceSchema>;

export const toggleVocabConnectionSchema = z.object({
  connectionId: z.string().trim().min(1, '缺少连接 ID'),
  enabled: z.boolean(),
});
export type ToggleVocabConnectionInput = z.infer<typeof toggleVocabConnectionSchema>;

export const generateVocabAssignmentSchema = z.object({
  assignmentDate: dateString,
});
export type GenerateVocabAssignmentInput = z.infer<typeof generateVocabAssignmentSchema>;

export const vocabSessionGranularitySchema = z.enum(VOCAB_SESSION_GRANULARITIES);
