/**
 * AI 分析结果的审核入参校验（T10）。
 *
 * 两条产品口径写在这里，不在 action 里：
 * 1. **"已修改采纳"必须真的提交了内容** —— 否则用户点完按钮看到的仍是 AI 原文，
 *    却以为自己的修改保存了。
 * 2. **批量操作不允许 `edited`** —— 编辑是逐条的语义，批量只做「全都采纳 / 全都拒绝」，
 *    否则一条 `editedPayload` 该套到哪几行上根本说不清。
 */

import { z } from 'zod';
import { MATERIAL_REVIEW_STATUSES } from '@/lib/constants';
import { enumFrom } from './common';

/** 单条裁决。 */
export const extractionReviewSchema = z
  .object({
    id: z.string().min(1).max(64),
    reviewStatus: enumFrom(MATERIAL_REVIEW_STATUSES, '审核状态'),
    /** 用户编辑后的结构化负载（只有 `edited` 允许携带）。 */
    editedPayload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.reviewStatus === 'edited' && !value.editedPayload) {
      ctx.addIssue({
        code: 'custom',
        path: ['editedPayload'],
        message: '标记为「已修改采纳」时必须提供编辑后的内容',
      });
    }
    if (value.reviewStatus !== 'edited' && value.editedPayload) {
      ctx.addIssue({
        code: 'custom',
        path: ['editedPayload'],
        message: '只有「已修改采纳」才允许提交编辑内容',
      });
    }
  });

export type ExtractionReviewInput = z.infer<typeof extractionReviewSchema>;

/** 批量裁决（只允许采纳/拒绝，最多 200 条一次）。 */
export const extractionBulkReviewSchema = z
  .object({
    materialId: z.string().min(1).max(64),
    ids: z.array(z.string().min(1).max(64)).min(1, '请先选择要处理的结果').max(200),
    reviewStatus: z.enum(['accepted', 'rejected']),
  })
  .strict();

export type ExtractionBulkReviewInput = z.infer<typeof extractionBulkReviewSchema>;

/** 材料域 id 入参（重新生成摘要 / 跳过练习 / 继续分析 / 确认部分可用）。 */
export const materialAnalysisTargetSchema = z
  .object({
    materialId: z.string().min(1).max(64),
  })
  .strict();

export type MaterialAnalysisTargetInput = z.infer<typeof materialAnalysisTargetSchema>;
