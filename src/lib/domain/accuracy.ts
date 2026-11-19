/**
 * 正确率口径 —— 纯函数。
 *
 * 全站唯一实现（PRD §6.6）：
 * - 平均正确率 = `Σcorrect / Σtotal`（加权）；
 * - **严禁**对 accuracy 数组取算术平均；
 * - `total = 0` 或 `null` 的样本直接剔除，**不当 0**；
 * - 全部被剔除 → 返回 `null`（UI 显示 `—`），不是 0。
 */

import type { AccSample } from '../types';

/**
 * 单次正确率。`total <= 0` → `null`。
 *
 * @example accuracyOf(9, 10) // 0.9
 * @example accuracyOf(0, 0)  // null
 */
export function accuracyOf(
  correct: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (total === null || total === undefined || total <= 0) return null;
  if (correct === null || correct === undefined) return null;
  const safeCorrect = Math.min(Math.max(0, correct), total);
  return safeCorrect / total;
}

/** 样本是否参与统计：`total > 0`。 */
export function isCountableSample(sample: AccSample): boolean {
  return typeof sample.total === 'number' && sample.total > 0;
}

/**
 * 加权正确率。
 *
 * @example weightedAccuracy([{total:9,correct:9},{total:0,correct:0},{total:3,correct:1}])
 *   // 10/12 ≈ 0.8333（total=0 被剔除，其余按 Σcorrect/Σtotal 加权）
 */
export function weightedAccuracy(samples: AccSample[]): number | null {
  let totalQuestions = 0;
  let totalCorrect = 0;
  for (const sample of samples) {
    if (!isCountableSample(sample)) continue;
    const total = sample.total as number;
    const correct = sample.correct ?? 0;
    totalQuestions += total;
    totalCorrect += Math.min(Math.max(0, correct), total);
  }
  if (totalQuestions === 0) return null;
  return totalCorrect / totalQuestions;
}

/** 把一批原始分组聚成 `{correct, total}`，便于先合并分子分母再相除。 */
export function mergeSampleTotals(samples: AccSample[]): {
  correct: number;
  total: number;
  accuracy: number | null;
} {
  let totalQuestions = 0;
  let totalCorrect = 0;
  for (const sample of samples) {
    if (!isCountableSample(sample)) continue;
    const total = sample.total as number;
    totalQuestions += total;
    totalCorrect += Math.min(Math.max(0, sample.correct ?? 0), total);
  }
  return {
    correct: totalCorrect,
    total: totalQuestions,
    accuracy: totalQuestions === 0 ? null : totalCorrect / totalQuestions,
  };
}

/**
 * 正确率缺口：科目整体正确率 − 该维度正确率，夹在 0..1。
 * 任一输入为 `null` 时返回 0（无数据不制造虚假薄弱）。
 */
export function accuracyGap(subjectAcc: number | null, dimensionAcc: number | null): number {
  if (subjectAcc === null || dimensionAcc === null) return 0;
  return Math.min(1, Math.max(0, subjectAcc - dimensionAcc));
}
