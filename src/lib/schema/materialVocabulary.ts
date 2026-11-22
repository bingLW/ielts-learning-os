/**
 * 材料词汇候选的入参校验（T12 §6）。
 *
 * 三条口径写在这里而不是散在 action 里：
 * 1. **裁决只能是 accepted / edited / rejected**：把一条候选改回 `draft` 等于
 *    「撤销裁决」，那应该删除重来 —— 否则 `reviewedAt` 语义会变成"最后一次点按钮
 *    的时间"，审计价值归零。
 * 2. **`edited` 必须给出词条**：改释义却连词条都不给，等于一次没有任何信息的
 *    编辑；而且 `normalizedLemma` / `contextHash` 都要靠它重算。
 * 3. **批量一律 200 条上限**：与练习批量栏、提取批量栏保持同一口径。
 */

import { z } from 'zod';
import { MATERIAL_SYNC_STATUSES } from '@/lib/constants';
import { enumFrom } from './common';

/** 允许通过裁决写入的三种状态（不含 `draft`，见文件头注释）。 */
export const VOCAB_CANDIDATE_REVIEW_STATUSES = ['accepted', 'edited', 'rejected'] as const;
export type VocabCandidateReviewStatus = (typeof VOCAB_CANDIDATE_REVIEW_STATUSES)[number];

/** 字段长度上限（与 `VocabularyItem` 的展示口径一致）。 */
export const VOCAB_LEMMA_MAX = 60;
export const VOCAB_POS_MAX = 20;
export const VOCAB_DEFINITION_MAX = 200;

/** 单次批量操作上限。 */
export const VOCAB_BULK_MAX = 200;

/** 候选 id（裁决 / 跳过 / 单条重试用）。 */
export const vocabCandidateIdSchema = z
  .object({
    id: z.string().min(1).max(64),
  })
  .strict();

export type VocabCandidateIdInput = z.infer<typeof vocabCandidateIdSchema>;

/**
 * 单条裁决。
 *
 * `lemma` / `pos` / `definitionZh` 只有在 `edited` 时才可能带值；
 * 但 schema 不强制"accepted 不许带" —— 带了也不会被使用（action 里只在
 * `edited` 分支读它们），这比让 UI 在切换状态时清空隐藏字段更稳。
 */
export const vocabCandidateReviewSchema = z
  .object({
    id: z.string().min(1).max(64),
    reviewStatus: enumFrom(VOCAB_CANDIDATE_REVIEW_STATUSES, '候选审核状态'),
    lemma: z.string().min(1).max(VOCAB_LEMMA_MAX, `词条长度不得超过 ${VOCAB_LEMMA_MAX} 字`).optional(),
    pos: z.string().max(VOCAB_POS_MAX, `词性长度不得超过 ${VOCAB_POS_MAX} 字`).optional(),
    definitionZh: z
      .string()
      .max(VOCAB_DEFINITION_MAX, `释义长度不得超过 ${VOCAB_DEFINITION_MAX} 字`)
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.reviewStatus !== 'edited' || (value.lemma ?? '').trim().length > 0,
    { message: '「修改后采纳」必须填写词条', path: ['lemma'] },
  );

export type VocabCandidateReviewInput = z.infer<typeof vocabCandidateReviewSchema>;

/** 批量采纳（只对 `draft` 生效，由 action 的 `updateMany` 条件保证）。 */
export const vocabCandidateBulkSchema = z
  .object({
    materialId: z.string().min(1).max(64),
    ids: z
      .array(z.string().min(1).max(64))
      .min(1, '请先选择要处理的候选')
      .max(VOCAB_BULK_MAX, `一次最多处理 ${VOCAB_BULK_MAX} 条`),
  })
  .strict();

export type VocabCandidateBulkInput = z.infer<typeof vocabCandidateBulkSchema>;

/**
 * 同步。`ids` 缺省 = 同步该材料所有「已采纳且待同步/上次失败」的候选。
 *
 * 为什么允许显式 `ids`：用户可能只想先把挑出来的 5 个词送进词库，
 * 剩下的等改完释义再说。
 */
export const vocabCandidateSyncSchema = z
  .object({
    materialId: z.string().min(1).max(64),
    ids: z
      .array(z.string().min(1).max(64))
      .max(VOCAB_BULK_MAX, `一次最多同步 ${VOCAB_BULK_MAX} 条`)
      .optional(),
  })
  .strict();

export type VocabCandidateSyncInput = z.infer<typeof vocabCandidateSyncSchema>;

/** 从已审核的分析结果补建候选（材料页按钮）。 */
export const materializeCandidatesSchema = z
  .object({
    materialId: z.string().min(1).max(64),
  })
  .strict();

export type MaterializeCandidatesInput = z.infer<typeof materializeCandidatesSchema>;

/**
 * `syncStatus` 的展示用枚举（与 `MATERIAL_SYNC_STATUSES` 同一来源）。
 *
 * 这里导出一个 `enumFrom` 版本，供将来"手工改同步状态"的运维入口复用；
 * 当前 action 不需要它（状态只能由同步流程自己写），但常量集中在这里，
 * 页面的筛选器直接用它做取值校验。
 */
export const syncStatusSchema = enumFrom(MATERIAL_SYNC_STATUSES, '同步状态');
