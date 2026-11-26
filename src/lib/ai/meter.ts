/**
 * Token 估算、成本计算与预算判断。
 *
 * 说明：没有使用真实分词器，token 按「字符数 / 3」估算并在 UI 标注为估算值；
 * 外部 Provider 返回 usage 时以返回值为准。所有函数为纯函数，便于单测。
 */

import { AI_ENGINE_DEFAULTS, FLOAT_EPSILON, TZ_NAME } from '@/lib/constants';

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

  // 0（或负值）明确表示不允许外部付费调用，首次调用也必须拒绝。
  const exceeded =
    config.dailyBudgetUsd <= 0 ||
    config.monthlyBudgetUsd <= 0 ||
    spend.dailyUsd + FLOAT_EPSILON >= config.dailyBudgetUsd ||
    spend.monthlyUsd + FLOAT_EPSILON >= config.monthlyBudgetUsd;

  const warned =
    dailyPercent >= config.warnPercent || monthlyPercent >= config.warnPercent;

  return {
    state: exceeded ? 'EXCEEDED' : warned ? 'WARN' : 'OK',
    dailyPercent: Math.round(dailyPercent * 10) / 10,
    monthlyPercent: Math.round(monthlyPercent * 10) / 10,
  };
}

/** 外部调用最坏情况预占：完整 system/user 字符估算 + 最大输出 token。 */
export function estimateMaxCallCostUsd(
  system: string,
  user: string,
  maxOutputTokens: number,
  prices: TokenPrices,
): number {
  return estimateCostUsd(
    estimateTokens(system) + estimateTokens(user),
    Math.max(0, Math.ceil(maxOutputTokens)),
    prices,
  );
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  const values = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

/**
 * 求指定 IANA 时区的当地日/月起点（返回 UTC 瞬时）。
 *
 * 不能把 UTC 日期直接当作用户日期：跨午夜与 DST 都会让预算窗口偏移。
 * 偏移迭代同时保留歧义/不存在时刻的两个候选，取目标当地日期的最早瞬时，
 * 因而春季午夜跳钟不会落到前一天，秋季重复午夜仍取第一次 00:00。
 */
function zonedLocalStart(
  now: Date,
  timeZone: string,
  month: number,
  day: number,
): Date {
  const local = zonedParts(now, timeZone);
  const targetAsUtc = Date.UTC(local.year, month - 1, day, 0, 0, 0);
  let guess = targetAsUtc;
  const candidates: number[] = [];

  for (let i = 0; i < 4; i += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    candidates.push(guess);
    guess = targetAsUtc - (representedAsUtc - guess);
  }

  const matching = candidates.filter((candidate) => {
    const parts = zonedParts(new Date(candidate), timeZone);
    return parts.year === local.year && parts.month === month && parts.day === day;
  });
  return new Date(matching.length > 0 ? Math.min(...matching) : guess);
}

/** 当天当地 0 点与当月 1 日当地 0 点；默认 TZ_NAME 保持既有纯函数调用兼容。 */
export function budgetWindows(
  now: Date,
  timeZone: string = TZ_NAME,
): { dayStart: Date; monthStart: Date } {
  const local = zonedParts(now, timeZone);
  return {
    dayStart: zonedLocalStart(now, timeZone, local.month, local.day),
    monthStart: zonedLocalStart(now, timeZone, local.month, 1),
  };
}