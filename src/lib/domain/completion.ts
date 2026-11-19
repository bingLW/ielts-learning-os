/**
 * 完成率与有效产出 —— 纯函数。
 *
 * 口径（PRD §6.6）：
 * - 任务完成权重：DONE=1；IN_PROGRESS/PARTIAL=clamp(actual/planned,0,1)；TODO/MISSED=0；
 * - 按时长加权：`Σ(权重 × 计划min) / Σ(计划min)`；
 * - 周完成率必须**先合并全周分子分母再相除**，不取日均值的平均；
 * - 顺延任务「原日剔除、目标日计入」：单日视图调用 `completionRate(items, viewDate)`；
 * - 分母为 0 → `null`（不是 0）。
 */

import { TASK_STATUSES_EXCLUDED_FROM_RATE, WEAKNESS_WEIGHTS } from '../constants';
import type { CompletionItem, CompletionRate, TaskStatus } from '../types';

/** 单任务完成权重。`plannedMinutes <= 0` 时无法加权，按状态退化为 0/1。 */
export function taskWeight(task: CompletionItem): number {
  if (task.status === 'DONE') return 1;
  if (task.status === 'IN_PROGRESS' || task.status === 'PARTIAL') {
    if (task.plannedMinutes <= 0) return task.actualMinutes > 0 ? 1 : 0;
    return Math.min(1, Math.max(0, task.actualMinutes / task.plannedMinutes));
  }
  return 0;
}

/**
 * 顺延任务的分母归属：原日剔除（moved_out），目标日计入（moved_in）。
 *
 * 这里只做「当前视图是否应统计该行」的判断，避免同一条任务在两个日期各被计一次。
 * `completionRate` 传了 `viewDate` 时会自动调用本函数；不传则原样统计（周/月聚合场景）。
 */
export function isCountableForDate(task: CompletionItem, viewDate: string): boolean {
  if (task.movedFromDate === viewDate) return false;
  return true;
}

/**
 * 该行是否进入完成率分母。
 *
 * v2.1：`CANCELLED`（用户主动取消）与 `DEFERRED`（进入 backlog，未排入当日）
 * 一律不计入分母 —— 否则「休息日 / 短时预算」会被当成学习失败（需求 §7.2、T06）。
 * 这条与「顺延剔除」并列，都是分母口径的一部分。
 */
export function isRateEligible(task: CompletionItem): boolean {
  return !TASK_STATUSES_EXCLUDED_FROM_RATE.includes(task.status);
}

/**
 * 完成率（按时长加权 + 任务数副指标）。
 *
 * @param items 同一天的（或已合并的全周）任务
 * @param viewDate 可选「视图日期」：传了就先用 `isCountableForDate` 剔除「已顺延离开本日」的行
 *   （缺陷 D5 的修法）。调用方必须同时把真实的 `movedFromDate` 传进来，否则过滤无从生效。
 */
export function completionRate(items: CompletionItem[], viewDate?: string): CompletionRate {
  const countable = items
    .filter(isRateEligible)
    .filter((item) =>
      typeof viewDate === 'string' && viewDate.length > 0 ? isCountableForDate(item, viewDate) : true,
    );

  let plannedTotal = 0;
  let weightedTotal = 0;
  let doneCount = 0;
  for (const item of countable) {
    const planned = Math.max(0, item.plannedMinutes);
    plannedTotal += planned;
    weightedTotal += taskWeight(item) * planned;
    if (item.status === 'DONE') doneCount += 1;
  }
  const count = countable.length;
  return {
    byTime: plannedTotal === 0 ? null : weightedTotal / plannedTotal,
    byCount: count === 0 ? null : doneCount / count,
  };
}

/**
 * 周完成率：先合并分子分母再相除。
 * 直接调用 `completionRate` 并传入全周条目即可满足该口径 —— 本函数只是把它显式化。
 */
export function weeklyCompletionRate(itemsOfWeek: CompletionItem[]): CompletionRate {
  return completionRate(itemsOfWeek);
}

/** 投入缺口：`clamp((planned - actual)/planned, 0, 1)`，`planned=0` 取 0。 */
export function investGap(plannedMinutes: number, actualMinutes: number): number {
  if (plannedMinutes <= 0) return 0;
  const gap = (plannedMinutes - actualMinutes) / plannedMinutes;
  return Math.min(1, Math.max(0, gap));
}

/** 有效产出判定的原始信号（来自 `StudyRecord` + 关联错题数）。 */
export interface OutputSignal {
  totalQuestions: number;
  outputText?: string | null;
  recordingUrl?: string | null;
  mistakeCount?: number;
  summaryEn?: string | null;
}

/** `output_text` 计入有效产出的最小字数（PRD Q5）。 */
export const MIN_OUTPUT_TEXT_LENGTH = 20;

/**
 * 是否构成「有效产出」（PRD Q5，满足任一即可）：
 * ①有正确率（total>0）②output_text ≥20 字 ③有录音链接 ④关联错题 ≥1 ⑤有英文摘要。
 */
export function isEffectiveOutput(signal: OutputSignal): boolean {
  if (signal.totalQuestions > 0) return true;
  if ((signal.outputText ?? '').trim().length >= MIN_OUTPUT_TEXT_LENGTH) return true;
  if ((signal.recordingUrl ?? '').trim().length > 0) return true;
  if ((signal.mistakeCount ?? 0) >= 1) return true;
  if ((signal.summaryEn ?? '').trim().length > 0) return true;
  return false;
}

/** 有效产出率：`有产出的记录数 / 全部记录数`；无记录 → `null`。 */
export function effectiveOutputRatio(records: OutputSignal[]): number | null {
  if (records.length === 0) return null;
  const hits = records.filter((record) => isEffectiveOutput(record)).length;
  return hits / records.length;
}

/** 有效产出条数（Dashboard「有效产出数」区块直接用这个）。 */
export function effectiveOutputCount(records: OutputSignal[]): number {
  return records.filter((record) => isEffectiveOutput(record)).length;
}

/** 状态是否属于「已执行」（参与正确率/完成率统计的状态）。 */
export function isExecutedStatus(status: TaskStatus): boolean {
  return status === 'DONE' || status === 'PARTIAL';
}

/** 时间缺口权重固定值导出（防止有人调高「练得少就补谁」的权重）。 */
export const INVEST_GAP_WEIGHT = WEAKNESS_WEIGHTS.INVEST_GAP;
