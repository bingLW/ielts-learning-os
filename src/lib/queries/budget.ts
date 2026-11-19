/**
 * v2.1 预算与周目标的只读查询。
 *
 * 预算解析优先级（自高到低）：
 * 1. `DailyBudget`（该日期已被用户显式设定）
 * 2. `PlannerSettings.weekdayProfiles[星期]`（按星期模板）
 * 3. `PlannerSettings.defaultDailyMinutes`（初始建议值，标记为建议，不是真实可用时间）
 *
 * 绝不回落到 `UserProfile.dailyMinutes`（v2.0 的 240 分钟）——
 * 那正是 v2.1 要废除的「默认 240」假设。
 */

import { BUDGET_INITIAL_SUGGESTION, BUDGET_MINUTES_MAX, BUDGET_MINUTES_MIN } from '@/lib/constants';
import { dayOfWeek, today } from '@/lib/date';
import { prisma } from '@/lib/prisma';
import type { BudgetSource, BudgetTierCode, BudgetType } from '@/lib/types';

/** 解析后的有效预算（供计划引擎与 UI 使用）。 */
export interface EffectiveBudget {
  date: string;
  minutes: number;
  isRestDay: boolean;
  tierCode: string | null;
  budgetType: BudgetType;
  source: BudgetSource;
  /** true 表示「这是系统建议的初始值」而非用户真实设定（首次安装 60 分钟场景）。 */
  isSuggestion: boolean;
  budgetId: string | null;
}

/** 星期模板解析结果。 */
export interface WeekdayProfile {
  /** 周日..周六，7 个值；0 = 休息日。 */
  minutes: number[];
  source: 'PLANNER_SETTINGS';
}

/** 读取 PlannerSettings（不存在时返回 null，由迁移或设置页创建）。 */
export async function getPlannerSettings() {
  return prisma.plannerSettings.findUnique({ where: { id: 1 } });
}

/** 解析 `weekdayProfiles` JSON；损坏时回落到「全 60 + 周日休息」。 */
export function parseWeekdayProfiles(raw: string | null | undefined): number[] {
  const fallback = [60, 60, 60, 60, 60, 60, 0];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 7) return fallback;
    return parsed.map((value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= BUDGET_MINUTES_MAX ? Math.round(n) : 0;
    });
  } catch {
    return fallback;
  }
}

/** 该日期的有效预算。 */
export async function getEffectiveBudget(date: string = today()): Promise<EffectiveBudget> {
  const [daily, settings] = await Promise.all([
    prisma.dailyBudget.findUnique({ where: { date } }),
    getPlannerSettings(),
  ]);

  if (daily) {
    return {
      date,
      minutes: daily.plannedAvailableMinutes,
      isRestDay: daily.isRestDay,
      tierCode: daily.tierCode,
      budgetType: daily.budgetType as BudgetType,
      source: daily.source as BudgetSource,
      isSuggestion: daily.isInitialSuggestion,
      budgetId: daily.id,
    };
  }

  const profiles = parseWeekdayProfiles(settings?.weekdayProfiles);
  const dow = dayOfWeek(date);
  const weekdayMinutes = profiles[dow] ?? 0;

  // 用户从未确认过日程配置：星期模板与默认值都只是**初始建议**，
  // 不能冒充「用户真实可用时间」，也不能因为模板里写了 0 就判成休息日。
  if (settings && !settings.isUserConfirmed) {
    return {
      date,
      minutes: settings.defaultDailyMinutes,
      isRestDay: false,
      tierCode: null,
      budgetType: 'PRESET',
      source: 'DEFAULT_SUGGESTION',
      isSuggestion: true,
      budgetId: null,
    };
  }

  if (settings && weekdayMinutes > 0) {
    return {
      date,
      minutes: weekdayMinutes,
      isRestDay: false,
      tierCode: null,
      budgetType: 'PRESET',
      source: 'WEEKDAY_TEMPLATE',
      isSuggestion: false,
      budgetId: null,
    };
  }
  if (settings && weekdayMinutes === 0) {
    // 星期模板明确写了 0：视为休息日，而不是「回落到默认 60」
    return {
      date,
      minutes: 0,
      isRestDay: true,
      tierCode: 'REST',
      budgetType: 'REST_DAY',
      source: 'WEEKDAY_TEMPLATE',
      isSuggestion: false,
      budgetId: null,
    };
  }

  return {
    date,
    minutes: settings?.defaultDailyMinutes ?? BUDGET_INITIAL_SUGGESTION,
    isRestDay: false,
    tierCode: null,
    budgetType: 'PRESET',
    source: 'DEFAULT_SUGGESTION',
    isSuggestion: true,
    budgetId: null,
  };
}

/** 区间内每一天的有效预算（周视图用；不产生数据库写入）。 */
export async function getBudgetRange(
  dates: string[],
): Promise<Map<string, EffectiveBudget>> {
  const [dailyRows, settings] = await Promise.all([
    prisma.dailyBudget.findMany({ where: { date: { in: dates } } }),
    getPlannerSettings(),
  ]);
  const byDate = new Map(dailyRows.map((row) => [row.date, row]));
  const profiles = parseWeekdayProfiles(settings?.weekdayProfiles);
  const out = new Map<string, EffectiveBudget>();
  const unconfirmed = Boolean(settings && !settings.isUserConfirmed);

  for (const date of dates) {
    const row = byDate.get(date);
    if (row) {
      out.set(date, {
        date,
        minutes: row.plannedAvailableMinutes,
        isRestDay: row.isRestDay,
        tierCode: row.tierCode,
        budgetType: row.budgetType as BudgetType,
        source: row.source as BudgetSource,
        isSuggestion: row.isInitialSuggestion,
        budgetId: row.id,
      });
      continue;
    }
    if (unconfirmed) {
      // 未确认的配置只算建议值，不是用户真实可用时间
      out.set(date, {
        date,
        minutes: settings?.defaultDailyMinutes ?? BUDGET_INITIAL_SUGGESTION,
        isRestDay: false,
        tierCode: null,
        budgetType: 'PRESET',
        source: 'DEFAULT_SUGGESTION',
        isSuggestion: true,
        budgetId: null,
      });
      continue;
    }
    const weekdayMinutes = profiles[dayOfWeek(date)] ?? 0;
    out.set(date, {
      date,
      minutes: weekdayMinutes,
      isRestDay: weekdayMinutes === 0,
      tierCode: weekdayMinutes === 0 ? 'REST' : null,
      budgetType: weekdayMinutes === 0 ? 'REST_DAY' : 'PRESET',
      source: 'WEEKDAY_TEMPLATE',
      isSuggestion: false,
      budgetId: null,
    });
  }
  return out;
}

/** 校验候选预算是否在合法区间内（0 表示休息日，单独放行）。 */
export function clampBudgetMinutes(minutes: number): number | null {
  if (!Number.isFinite(minutes)) return null;
  const rounded = Math.round(minutes);
  if (rounded === 0) return 0;
  if (rounded < BUDGET_MINUTES_MIN || rounded > BUDGET_MINUTES_MAX) return null;
  return rounded;
}

/** 该周（ISO 周一为起点）的周目标。 */
export async function getWeeklyTarget(weekStart: string) {
  return prisma.weeklyTarget.findUnique({
    where: { weekStart },
    include: { allocations: { orderBy: { date: 'asc' } } },
  });
}

/** 最近的周目标列表（可持续性建议用）。 */
export async function listRecentWeeklyTargets(beforeWeekStart: string, count = 4) {
  return prisma.weeklyTarget.findMany({
    where: { weekStart: { lt: beforeWeekStart } },
    orderBy: { weekStart: 'desc' },
    take: count,
  });
}

/** 档次编码 → 预算类型。 */
export function budgetTypeOf(tierCode: string): BudgetType {
  if (tierCode === 'REST') return 'REST_DAY';
  if (tierCode === 'CUSTOM') return 'CUSTOM';
  return 'PRESET';
}

/** 类型守卫：是否属于已知档次编码。 */
export function asTierCode(value: string | null | undefined): BudgetTierCode | null {
  if (!value) return null;
  const known: BudgetTierCode[] = [
    'EMERGENCY',
    'MINIMUM',
    'LIGHT',
    'LIGHT_STANDARD',
    'STANDARD',
    'FOCUSED',
    'DEEP',
    'EXTENDED',
    'CUSTOM',
    'REST',
  ];
  return known.includes(value as BudgetTierCode) ? (value as BudgetTierCode) : null;
}
