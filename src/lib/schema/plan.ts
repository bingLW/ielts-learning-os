/**
 * 计划 / 任务 / 计时器相关的 zod 契约。
 *
 * 计时器相关 schema 只收 `expectedVersion` —— **绝不接收客户端算出的 elapsed**，
 * 时长一律由服务端时钟计算（否则前端改系统时间就能刷时长）。
 */

import { z } from 'zod';
import {
  BUDGET_MINUTES_MAX,
  DAILY_MINUTES_MAX,
  DAILY_MINUTES_MIN,
  LEARNING_TRACKS,
  MODULE_ORDER,
  PRIMARY_SKILLS,
  S0_MODULES,
  SKILL_IDS,
  TASK_STATUSES,
} from '../constants';
import { dateString, enumFrom, minutesField, optionalId, optionalText } from './common';

const ALL_MODULES = [...S0_MODULES, ...MODULE_ORDER];

/** 生成当日计划。 */
export const generatePlanSchema = z.object({
  stageId: z.string().min(1, '必须指定阶段').optional(),
  planDate: dateString,
  dailyMinutes: z.coerce
    .number()
    .int('必须为整数')
    .min(DAILY_MINUTES_MIN, `每日时长不得少于 ${DAILY_MINUTES_MIN} 分钟`)
    .max(DAILY_MINUTES_MAX, `每日时长不得超过 ${DAILY_MINUTES_MAX} 分钟`),
});
export type GeneratePlanInput = z.infer<typeof generatePlanSchema>;

/**
 * v2.1 自适应生成：预算放宽到 0–600 分钟（含自定义值；0 = 休息日，不生成任务）。
 * 与 v2.0 的 240–300 契约并行存在，不替换旧入口。
 */
export const generateAdaptivePlanSchema = z.object({
  stageId: z.string().min(1, '必须指定阶段').optional(),
  planDate: dateString,
  dailyMinutes: z.coerce
    .number()
    .int('必须为整数')
    .min(0, '每日时长不得为负数')
    .max(600, '每日时长不得超过 600 分钟'),
});
export type GenerateAdaptivePlanInput = z.infer<typeof generateAdaptivePlanSchema>;

/** 新建任务。 */
export const createPlanTaskSchema = z.object({
  stageId: z.string().min(1, '必须指定阶段'),
  planDate: dateString,
  module: enumFrom(ALL_MODULES, '模块'),
  skill: enumFrom(SKILL_IDS, '科目'),
  // v2.1：单任务上限跟随预算上限（240 分钟档的技能池就有 170 分钟，整篇写作也可能超过 180）
  plannedMinutes: minutesField(1, BUDGET_MINUTES_MAX),
  sortOrder: z.coerce.number().int().min(0).optional(),
  resourceId: optionalId,
  note: optionalText(300),
  // v2.0：不传时由 `MODULE_TRACK` / `MODULE_TO_PRIMARY` 推导，
  // 传了则以传入值为准（例如把一条 READING 任务显式挂到 IELTS 轨道）。
  track: enumFrom(LEARNING_TRACKS, '轨道').optional(),
  primarySkill: enumFrom(PRIMARY_SKILLS, '四技能').optional(),
});
export type CreatePlanTaskInput = z.infer<typeof createPlanTaskSchema>;

/** 修改任务（就地改时长 / 换资源 / 改备注）。 */
export const updatePlanTaskSchema = z.object({
  taskId: z.string().min(1, '缺少任务 ID'),
  plannedMinutes: minutesField(1, BUDGET_MINUTES_MAX).optional(),
  resourceId: z.union([z.string().min(1), z.literal('')]).optional(),
  note: optionalText(300),
});
export type UpdatePlanTaskInput = z.infer<typeof updatePlanTaskSchema>;

/** 拖拽调序。 */
export const reorderPlanTasksSchema = z.object({
  planDate: dateString,
  orderedIds: z.array(z.string().min(1)).min(1, '至少需要一个任务'),
});
export type ReorderPlanTasksInput = z.infer<typeof reorderPlanTasksSchema>;

/** 开始计时。 */
export const startTimerSchema = z.object({
  taskId: z.string().min(1, '缺少任务 ID'),
  expectedVersion: z.coerce.number().int().min(0),
});
export type StartTimerInput = z.infer<typeof startTimerSchema>;

/** 心跳 / 活跃标记。 */
export const touchTimerSchema = z.object({
  taskId: z.string().min(1, '缺少任务 ID'),
  expectedVersion: z.coerce.number().int().min(0),
});
export type TouchTimerInput = z.infer<typeof touchTimerSchema>;

/** 暂停计时（服务端凭 `timerStartedAt` 算本次净时长）。 */
export const pauseTimerSchema = z.object({
  taskId: z.string().min(1, '缺少任务 ID'),
  expectedVersion: z.coerce.number().int().min(0),
});
export type PauseTimerInput = z.infer<typeof pauseTimerSchema>;

/** 完成 / 部分完成 / 未完成。 */
export const finishTaskSchema = z
  .object({
    taskId: z.string().min(1, '缺少任务 ID'),
    outcome: enumFrom(['DONE', 'PARTIAL', 'MISSED', 'CANCELLED', 'DEFERRED'] as const, '任务结果'),
    actualMinutes: z.coerce.number().int().min(0).max(600).optional(),
    missReason: optionalText(500),
  })
  .refine((value) => value.outcome !== 'PARTIAL' || (value.actualMinutes ?? 0) > 0, {
    message: '部分完成必须填写实际分钟',
    path: ['actualMinutes'],
  });
export type FinishTaskInput = z.infer<typeof finishTaskSchema>;

/** 状态流转。 */
export const patchTaskStatusSchema = z.object({
  taskId: z.string().min(1, '缺少任务 ID'),
  to: enumFrom(TASK_STATUSES, '任务状态'),
});
export type PatchTaskStatusInput = z.infer<typeof patchTaskStatusSchema>;

/** 顺延到其他日期。 */
export const moveTaskSchema = z.object({
  taskId: z.string().min(1, '缺少任务 ID'),
  targetDate: dateString,
});
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;

/** 当日总结。 */
export const dailySummarySchema = z.object({
  summaryDate: dateString,
  draftText: optionalText(4000),
});
export type DailySummaryInput = z.infer<typeof dailySummarySchema>;
