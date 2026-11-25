/**
 * 规划器（v2.7）的 zod 契约 —— 权重与分层阈值。
 *
 * 两条约束决定了这里的写法：
 *
 * 1. **校验失败不许回落默认值**。一个 Σ=0.9 的权重表被"宽容地"补成默认值，
 *    等于把用户的配置静默丢掉，而界面上显示的仍是用户填的那份 —— 分数却是默认权重算的。
 *    失败就返回 `VALIDATION`，让调用方把错误显示在字段旁边。
 * 2. **未知键一律拒**（`.strict()`）。多出来的键不会参与求和，却会让人以为它生效了；
 *    而权重表是进 `inputHash` 的东西，多一个键就等于"同一个配置两个 hash"。
 */

import { z } from 'zod';
import {
  PRIORITY_FACTOR_KEYS,
  PRIORITY_THRESHOLDS,
  PRIORITY_WEIGHTS_VERSION,
  STAGE_CODES,
  TRANSITION_REASON_MIN_LENGTH,
} from '../constants';
import { enumFrom } from './common';
import { failValidation } from '../result';
import type { ActionResult } from '../types';
import type { PriorityWeights } from '../domain/taskPriority';

/** 权重之和的允许误差（`41 §2.4`：`|Σ−1| < 1e-9`）。 */
export const WEIGHTS_SUM_EPSILON = 1e-9;

const unitWeight = z
  .number()
  .finite('权重必须是有限数')
  .min(0, '权重不能为负')
  .max(1, '单项权重不能超过 1');

/**
 * 七因子权重。
 *
 * 逐键显式列出（而不是 `z.record(...)`）：`Record` 版会接受缺键与多余键，
 * 而缺键在评分时会变成 `undefined` → `score = NaN` → 排序静默乱序。
 */
export const priorityWeightsSchema = z
  .object({
    urgency: unitWeight,
    goalRelevance: unitWeight,
    evidenceStrength: unitWeight,
    errorRecurrence: unitWeight,
    prerequisiteReady: unitWeight,
    timeCost: unitWeight,
    preferenceFit: unitWeight,
  })
  .strict()
  .refine(
    (weights) => {
      let sum = 0;
      for (const key of PRIORITY_FACTOR_KEYS) sum += weights[key];
      return Math.abs(sum - 1) < WEIGHTS_SUM_EPSILON;
    },
    { message: '七项权重之和必须等于 1（|Σ−1| < 1e-9）' },
  );

/** 分层阈值：`p1` 必须严格大于 `p2`，且都在 (0, 1] 内。 */
export const priorityThresholdsSchema = z
  .object({
    p1: z.number().finite().gt(0).max(1),
    p2: z.number().finite().gt(0).max(1),
  })
  .strict()
  .refine((t) => t.p1 > t.p2, { message: 'P1 阈值必须严格大于 P2 阈值' });

/** 完整权重配置（含版本号）。 */
export const priorityWeightsConfigSchema = z
  .object({
    weightsVersion: z.string().min(1),
    weights: priorityWeightsSchema,
    thresholds: priorityThresholdsSchema,
  })
  .strict();

export type PriorityWeightsConfigInput = z.infer<typeof priorityWeightsConfigSchema>;

/**
 * 校验一份权重表；失败返回 `VALIDATION`，**不回落默认值**。
 *
 * 与直接 `schema.safeParse` 的区别：这里返回 `ActionResult`，错误已经按字段路径摊平，
 * 可以直接交给表单渲染。
 */
export function validatePriorityWeights(raw: unknown): ActionResult<PriorityWeights> {
  const parsed = priorityWeightsSchema.safeParse(raw);
  if (!parsed.success) return failValidation<PriorityWeights>(parsed.error, '权重配置不合法');
  return { ok: true, data: parsed.data };
}

/** 默认阈值（与 `PRIORITY_THRESHOLDS` 同源，导出只为让调用点少 import 一处）。 */
export const DEFAULT_PRIORITY_THRESHOLDS = PRIORITY_THRESHOLDS;

/** 默认权重版本。 */
export const DEFAULT_WEIGHTS_VERSION = PRIORITY_WEIGHTS_VERSION;

// ───────────────────────── T07 计划构建 / 确认 / 草稿 ─────────────────────────

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD');

const horizonDays = z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]);

/** 生成计划预览（`41 §2.10`）。 */
export const planPreviewSchema = z
  .object({
    purpose: z.enum(['GENERATE', 'REPLAN']),
    asOfDate: dateString,
    horizonDays,
    stageId: z.string().min(1).optional(),
    planDate: dateString.optional(),
    budgetOverrideMinutes: z.number().int().min(0).max(600).optional(),
    allowAi: z.boolean().optional(),
    draftId: z.string().nullable().optional(),
  })
  .strict();

export type PlanPreviewInput = z.infer<typeof planPreviewSchema>;

/** 确认计划版本（含预览令牌，保证「预览 == 实际」，`41 §2.10`）。 */
export const planConfirmSchema = z
  .object({
    snapshotId: z.string().min(1, '缺少快照 ID'),
    previewToken: z.string().min(1, '缺少预览令牌'),
    purpose: z.enum(['GENERATE', 'REPLAN']),
    asOfDate: dateString,
    horizonDays,
    stageId: z.string().min(1).optional(),
    planDate: dateString.optional(),
    budgetOverrideMinutes: z.number().int().min(0).max(600).optional(),
    allowAi: z.boolean().optional(),
  })
  .strict();

export type PlanConfirmInput = z.infer<typeof planConfirmSchema>;

/** 保存草稿（T07 复用 PlanningSnapshot 作为草稿锚点）。 */
export const planDraftSchema = z
  .object({
    purpose: z.enum(['GENERATE', 'REPLAN']),
    asOfDate: dateString,
    horizonDays,
    stageId: z.string().min(1).optional(),
    planDate: dateString.optional(),
    budgetOverrideMinutes: z.number().int().min(0).max(600).optional(),
    allowAi: z.boolean().optional(),
  })
  .strict();

export type PlanDraftInput = z.infer<typeof planDraftSchema>;

/** 提升候选优先级（只改决策，不写 PlanTask，`41 §2.10`）。 */
export const candidatePromoteSchema = z
  .object({
    candidateId: z.string().min(1),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  })
  .strict();

export type CandidatePromoteInput = z.infer<typeof candidatePromoteSchema>;

/** 恢复历史版本（生成新版本，`41 §5.5`）。 */
export const versionRestoreSchema = z
  .object({
    versionId: z.string().min(1),
  })
  .strict();

export type VersionRestoreInput = z.infer<typeof versionRestoreSchema>;

// ───────────────────────── T08 重排预览 / 确认 ─────────────────────────

/** 重排预览（dry-run，`41 §2.7`）。 */
export const replanPreviewSchema = z
  .object({
    planDate: dateString,
    newBudgetMinutes: z.number().int().min(0).max(600),
    isRestDay: z.boolean().optional(),
    reason: z.string().max(500).optional(),
    lockedTaskIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict();

export type ReplanPreviewSchemaInput = z.infer<typeof replanPreviewSchema>;

/** 确认重排（含预览令牌与幂等键，`41 §2.7`）。 */
export const replanConfirmSchema = replanPreviewSchema
  .extend({
    previewToken: z.string().min(1, '缺少预览令牌'),
    idempotencyKey: z.string().min(1).max(120),
  })
  .strict();

export type ReplanConfirmSchemaInput = z.infer<typeof replanConfirmSchema>;

// ───────────────────────── T09 readiness / 阶段切换 ─────────────────────────

/** readiness 评审（生成 `StageReadinessReview` 快照，`41 §2.10`）。 */
export const readinessReviewSchema = z
  .object({
    stageId: z.string().min(1, '缺少阶段 ID'),
    asOfDate: dateString,
  })
  .strict();

export type ReadinessReviewInput = z.infer<typeof readinessReviewSchema>;

/**
 * 用户确认进入下一阶段（`41 §2.10`）：系统只建议，用户才生效。
 *
 * `confirmedBy` 必填（PRD §4.9：确认人 = 本人）；`reason` 沿用全局最小长度
 * `TRANSITION_REASON_MIN_LENGTH`，与既有 `transitionStageAction` 同一条硬约束。
 */
export const stageTransitionSchema = z
  .object({
    reviewId: z.string().min(1, '缺少 readiness 评审 ID'),
    toStageCode: enumFrom(STAGE_CODES, '目标阶段编码'),
    reason: z
      .string()
      .trim()
      .min(TRANSITION_REASON_MIN_LENGTH, `升级原因至少 ${TRANSITION_REASON_MIN_LENGTH} 个字`),
    confirmedBy: z.string().trim().min(1, '请填写确认人'),
    note: z.string().max(2000).optional(),
  })
  .strict();

export type StageTransitionSchemaInput = z.infer<typeof stageTransitionSchema>;
