/**
 * 有效预算解析 —— **纯函数，唯一真值来源**（v2.7 修 R-2 读侧翻版）。
 *
 * 为什么必须抽出来：`getEffectiveBudget`（逐日）与 `getBudgetRange`（批量）原本是
 * 两份并行实现，看起来"逻辑一致"，实际在「没有 `PlannerSettings` 行」这条路径上
 * **分叉**：前者回落到初始建议 60 且标记 `isSuggestion:true`，后者按
 * `[60,60,60,60,60,60,0]` 的星期模板算，于是周日得到「0 分钟 + 休息日 + 非建议」。
 * 后果不是"显示不一致"，而是 H4 的分母与计划引擎的预算打架：用户周日排了 60 分钟，
 * H4 认为那天没有可比样本；预算页也会把初始建议值当成用户真实设定。
 *
 * 修法是**只留一处判定**：本文件按固定顺序给出结论，两个查询函数退化成薄壳
 * （读 → 调这里 → 返回）。任何"if 未确认 / if 模板为 0"的分支都不允许再出现在查询层。
 *
 * 分支顺序**不可重排**（它是文档写明的优先级，且顺序本身就是语义）：
 * 1. `DailyBudget` 显式设定 → 最高优先，原样透传；
 * 2. 配置存在但**用户从未确认** → 只用 `defaultDailyMinutes` 作建议值；
 * 3. 模板该星期 > 0 → 按模板；
 * 4. 模板该星期 == 0 → 休息日（不是"回落到 60"）；
 * 5. 其余（含**没有配置行**）→ `defaultDailyMinutes` 或初始建议 60，且**标记为建议**。
 *
 * 第 2 条与第 5 条都必须 `isSuggestion: true`：它们给出的数字都不是用户真实声明的
 * 可用时间，UI 必须能区分"用户说每天 60 分钟"和"系统猜你每天 60 分钟"。
 */

import { BUDGET_INITIAL_SUGGESTION, BUDGET_MINUTES_MAX } from '@/lib/constants';
import { dayOfWeek } from '@/lib/date';
import type { BudgetSource, BudgetType } from '@/lib/types';

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

/**
 * 星期模板的兜底值：全 60 + 周日休息。
 *
 * 只在 `weekdayProfiles` 缺失或损坏时使用。注意它**只在配置存在时**才参与分支 3/4；
 * 没有配置行时走分支 5（初始建议），不会走到这里 —— 这正是本次修正的关键差别。
 */
const WEEKDAY_PROFILE_FALLBACK = [60, 60, 60, 60, 60, 60, 0];

/** 解析 `weekdayProfiles` JSON；损坏时回落到「全 60 + 周日休息」。 */
export function parseWeekdayProfiles(raw: string | null | undefined): number[] {
  if (!raw) return [...WEEKDAY_PROFILE_FALLBACK];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 7) return [...WEEKDAY_PROFILE_FALLBACK];
    return parsed.map((value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= BUDGET_MINUTES_MAX ? Math.round(n) : 0;
    });
  } catch {
    return [...WEEKDAY_PROFILE_FALLBACK];
  }
}

/** 解析所需的原始数据（由查询层读好后传进来，本函数不碰数据库）。 */
export interface BudgetResolveInput {
  date: string;
  /** 该日期的 `DailyBudget` 行（没有则为 null）。 */
  daily: {
    id: string;
    plannedAvailableMinutes: number;
    isRestDay: boolean;
    tierCode: string | null;
    budgetType: string;
    source: string;
    isInitialSuggestion: boolean;
  } | null;
  /** `PlannerSettings`（不存在时为 null）。 */
  settings: {
    isUserConfirmed: boolean;
    weekdayProfiles: string | null;
    defaultDailyMinutes: number;
  } | null;
}

/**
 * 解析某一天的有效预算。
 *
 * @param input 日期 + 当日 `DailyBudget` 行 + `PlannerSettings`
 */
export function resolveEffectiveBudget(input: BudgetResolveInput): EffectiveBudget {
  const { date, daily, settings } = input;

  // ── 1. 用户显式设定过这一天 → 原样采纳 ──
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

  // ── 2. 配置存在但用户从未确认 → 只是建议，不冒充真实可用时间 ──
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

  const profiles = parseWeekdayProfiles(settings?.weekdayProfiles);
  const weekdayMinutes = profiles[dayOfWeek(date)] ?? 0;

  // ── 3. 模板明确给了正数 → 这是用户真实设定 ──
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

  // ── 4. 模板明确写了 0 → 休息日，**不是**"回落到默认 60" ──
  if (settings && weekdayMinutes === 0) {
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

  // ── 5. 没有配置行（或配置损坏到拿不到分钟）→ 初始建议，必须标记为建议 ──
  //
  // 这一条是本次修正的实质：旧 `getBudgetRange` 在这里按星期模板算，于是
  // 「没有配置 + 周日」变成了"0 分钟休息日"，与计划引擎的"建议 60 分钟"打架。
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
