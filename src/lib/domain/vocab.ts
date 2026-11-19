/**
 * 词汇抽测 —— 纯函数。
 *
 * 权重：能主动使用 1.0 / 能理解 0.7 / 认识但不能用 0.3。
 * 三档**不可合并**统计：`已知/总数` 这种指标在本产品里没有意义。
 */

import {
  MASTERY_WEIGHT,
  VOCAB_ACC_DOWN_THRESHOLD,
  VOCAB_ACC_UP_THRESHOLD,
  VOCAB_NEW_DEFAULT,
  VOCAB_NEW_DOWN,
  VOCAB_NEW_MAX,
  VOCAB_NEW_MIN,
  VOCAB_NEW_STEP,
  VOCAB_NEW_UP,
} from '../constants';
import type { MasteryLevel } from '../types';

/**
 * 抽测加权正确率 = `Σ权重 / 词数`。
 * 样本为 0 → `null`（不做除零，也不返回 0 冒充数据）。
 */
export function quizAccuracy(ratings: MasteryLevel[]): number | null {
  if (ratings.length === 0) return null;
  const total = ratings.reduce((sum, level) => sum + (MASTERY_WEIGHT[level] ?? 0), 0);
  return total / ratings.length;
}

/**
 * 下周新词量建议。
 *
 * - 上周抽测 <80% → 降为 12（先保复习质量）；
 * - ≥90% → 在当前基础上 +4，上限 25（至少到 22）；
 * - 其余保持当前值，并夹在 15–25。
 */
export function suggestNewWordCount(
  lastWeekQuizAccuracy: number | null,
  current: number,
): { next: number; reason: string } {
  const clampedCurrent = Math.min(VOCAB_NEW_MAX, Math.max(VOCAB_NEW_MIN, Math.round(current)));

  if (lastWeekQuizAccuracy === null) {
    return {
      next: clampedCurrent,
      reason: `暂无抽测数据，维持当前 ${clampedCurrent} 个/天`,
    };
  }

  if (lastWeekQuizAccuracy < VOCAB_ACC_DOWN_THRESHOLD) {
    return {
      next: VOCAB_NEW_DOWN,
      reason: `上周抽测加权正确率 ${Math.round(lastWeekQuizAccuracy * 100)}% < 80%，下周新词量下调为 ${VOCAB_NEW_DOWN}，优先提高旧词复习占比`,
    };
  }

  if (lastWeekQuizAccuracy >= VOCAB_ACC_UP_THRESHOLD) {
    const boosted = Math.min(
      VOCAB_NEW_MAX,
      Math.max(VOCAB_NEW_UP, clampedCurrent + VOCAB_NEW_STEP),
    );
    return {
      next: boosted,
      reason: `上周抽测加权正确率 ${Math.round(lastWeekQuizAccuracy * 100)}% ≥ 90%，下周新词量可提升至 ${boosted}`,
    };
  }

  return {
    next: clampedCurrent,
    reason: `上周抽测加权正确率 ${Math.round(lastWeekQuizAccuracy * 100)}%，维持 ${clampedCurrent} 个/天`,
  };
}

/** 默认新词量（15–20 区间中位）。 */
export function defaultNewWordCount(): number {
  return VOCAB_NEW_DEFAULT;
}

/** 三档分布统计（禁止合并成单一「已掌握」）。 */
export function masteryDistribution(words: { mastery: MasteryLevel }[]): {
  RECOGNIZE_ONLY: number;
  COMPREHEND: number;
  ACTIVE_USE: number;
  total: number;
} {
  const out = { RECOGNIZE_ONLY: 0, COMPREHEND: 0, ACTIVE_USE: 0, total: words.length };
  for (const word of words) {
    out[word.mastery] += 1;
  }
  return out;
}
