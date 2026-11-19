/**
 * 周复盘 zod 契约。
 *
 * 两条硬约束：
 * 1. `(isoYear, isoWeek)` 唯一 —— 由数据库唯一索引兜底，action 用 upsert；
 * 2. 下周 Top3 薄弱点**必须填满 3 项**，少于 3 项直接拒收。
 */

import { z } from 'zod';
import {
  WEEKLY_METRIC_KEYS,
  WEEKLY_NOTE_MAX,
  WEEKLY_TOP3_COUNT,
} from '../constants';
import { dateString, enumFrom, optionalText } from './common';

/** Top3 单项。`manual = true` 表示用户手填，不需要自动打分。 */
export const weeklyTop3ItemSchema = z.object({
  name: z.string().trim().min(1, '薄弱点名称必填').max(120, '名称不超过 120 字'),
  score: z.coerce.number().min(0).max(1).optional(),
  evidence: optionalText(500),
  manual: z.boolean().optional(),
});
export type WeeklyTop3ItemInput = z.infer<typeof weeklyTop3ItemSchema>;

/** 13 项指标中的一项（提交时带 auto 便于回溯系统值）。 */
export const weeklyMetricEntrySchema = z.object({
  key: enumFrom(WEEKLY_METRIC_KEYS, '指标'),
  autoValue: z.string().max(2000, '自动值过长'),
  overrideValue: z.union([z.string().max(2000, '覆盖值过长'), z.literal('')]).optional(),
});
export type WeeklyMetricEntryInput = z.infer<typeof weeklyMetricEntrySchema>;

/** 保存周复盘（upsert 语义）。 */
export const saveWeeklyReviewSchema = z.object({
  isoYear: z.coerce.number().int().min(2000).max(2100),
  isoWeek: z.coerce.number().int().min(1).max(53),
  weekStart: dateString,
  weekEnd: dateString,
  isPartial: z.boolean().optional(),
  metrics: z.array(weeklyMetricEntrySchema).min(1, '缺少指标数据'),
  top3: z
    .array(weeklyTop3ItemSchema)
    .length(WEEKLY_TOP3_COUNT, `下周 Top3 薄弱点必须填满 ${WEEKLY_TOP3_COUNT} 项`),
  reviewNote: optionalText(WEEKLY_NOTE_MAX),
});
export type SaveWeeklyReviewInput = z.infer<typeof saveWeeklyReviewSchema>;
