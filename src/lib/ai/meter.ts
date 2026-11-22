/**
 * Token 估算、成本计算与预算判断。
 *
 * 说明：没有使用真实分词器，token 按「字符数 / 3」估算并在 UI 标注为估算值；
 * 外部 Provider 返回 usage 时以返回值为准。所有函数为纯函数，便于单测。
 */

import { AI_ENGINE_DEFAULTS } from '@/lib/constants';

export interface TokenPrices {
  inputPricePerMtok: number;
  outputPricePerMtok: number;
}

export interface BudgetConfig {
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  warnPercent: number;
}

export type BudgetState = 'OK' | 'WARN' | 'EXCEEDED';

/** 粗略 token 估算：英文约 4 字符/token，中文约 1.5 字符/token，取折中 3。 */
export function estimateTokens(text: string): number {
  const length = text.trim().length;
  if (length === 0) return 0;
  return Math.max(1, Math.ceil(length / 3));
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  prices: TokenPrices,
): number {
  const cost =
    (inputTokens / 1_000_000) * prices.inputPricePerMtok +
    (outputTokens / 1_000_000) * prices.outputPricePerMtok;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function budgetConfigFrom(
  setting:
    | {
        dailyBudgetUsd?: number | null;
        monthlyBudgetUsd?: number | null;
        warnPercent?: number | null;
      }
    | null
    | undefined,
): BudgetConfig {
  return {
    dailyBudgetUsd: setting?.dailyBudgetUsd ?? AI_ENGINE_DEFAULTS.dailyBudgetUsd,
    monthlyBudgetUsd: setting?.monthlyBudgetUsd ?? AI_ENGINE_DEFAULTS.monthlyBudgetUsd,
    warnPercent: setting?.warnPercent ?? AI_ENGINE_DEFAULTS.warnPercent,
  };
}

/**
 * 预算状态：任一周期超限即 EXCEEDED；达到预警比例即 WARN。
 * 预算为 0 视为「关闭外部付费调用」，已有支出才判超限，避免 0/0。
 */
export function evaluateBudget(
  spend: { dailyUsd: number; monthlyUsd: number },
  config: BudgetConfig,
): { state: BudgetState; dailyPercent: number; monthlyPercent: number } {
  const dailyPercent =
    config.dailyBudgetUsd > 0 ? (spend.dailyUsd / config.dailyBudgetUsd) * 100 : 0;
  const monthlyPercent =
    config.monthlyBudgetUsd > 0 ? (spend.monthlyUsd / config.monthlyBudgetUsd) * 100 : 0;

  const exceeded =
    (config.dailyBudgetUsd > 0 && spend.dailyUsd >= config.dailyBudgetUsd) ||
    (config.monthlyBudgetUsd > 0 && spend.monthlyUsd >= config.monthlyBudgetUsd) ||
    (config.dailyBudgetUsd <= 0 && spend.dailyUsd > 0) ||
    (config.monthlyBudgetUsd <= 0 && spend.monthlyUsd > 0);

  const warned =
    dailyPercent >= config.warnPercent || monthlyPercent >= config.warnPercent;

  return {
    state: exceeded ? 'EXCEEDED' : warned ? 'WARN' : 'OK',
    dailyPercent: Math.round(dailyPercent * 10) / 10,
    monthlyPercent: Math.round(monthlyPercent * 10) / 10,
  };
}

/** 当天 0 点（本地时区）与当月 1 日 0 点，用于预算聚合查询。 */
export function budgetWindows(now: Date): { dayStart: Date; monthStart: Date } {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return { dayStart, monthStart };
}