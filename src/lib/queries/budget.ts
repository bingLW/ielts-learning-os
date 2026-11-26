/**
 * v2.1 预算与周目标的只读查询。
 *
 * **本文件不再包含任何预算解析逻辑。**
 *
 * 解析只有一处：`domain/budget.resolveEffectiveBudget`（纯函数，五个分支的顺序即优先级）。
 * 这里只做两件事：把 `DailyBudget` / `PlannerSettings` 读出来，交给它算；把结果返回。
 *
 * 为什么要这样收口（v2.7 R-2 的读侧翻版）：原先 `getEffectiveBudget`（逐日）与
 * `getBudgetRange`（批量）是两份并行实现，在「没有 `PlannerSettings` 行」这条路径上
 * **分叉**了 —— 逐日版给「建议 60 分钟 / 非休息日 / isSuggestion:true」，
 * 批量版按星期模板给「周日 0 分钟 / 休息日 / isSuggestion:false」。
 * 后果有两个，都不是显示问题：
 * 1. H4 的分母失真：周视图认为周日 0 分钟（被 `<15` 静默跳过），计划引擎认为 60 分钟；
 * 2. `isSuggestion` 撒谎：把「系统猜的 60」说成「用户真实可用时间」。
 *
 * 现在两者共用同一条判定，分叉在结构上不可能再发生
 * （`domain/__tests__/budgetResolve.test.ts` 的等价性用例守着这一点）。
 *
 * 预算解析优先级（自高到低，实现见 `domain/budget.ts`）：
 * 1. `DailyBudget`（该日期已被用户显式设定）
 * 2. `PlannerSettings.weekdayProfiles[星期]`（按星期模板）
 * 3. `PlannerSettings.defaultDailyMinutes`（初始建议值，标记为建议，不是真实可用时间）
 *
 * 绝不回落到 `UserProfile.dailyMinutes`（v2.0 的 240 分钟）——
 * 那正是 v2.1 要废除的「默认 240」假设。
 */

import type { Prisma } from '@prisma/client';
import { BUDGET_MINUTES_MAX, BUDGET_MINUTES_MIN } from '@/lib/constants';
import { resolveBusinessDate } from '@/lib/businessTime';
import { resolveEffectiveBudget, type EffectiveBudget, type WeekdayProfile } from '@/lib/domain/budget';
import { prisma } from '@/lib/prisma';
import type { BudgetTierCode, BudgetType } from '@/lib/types';

/**
 * 允许传入事务客户端：v2.7 `appendTaskFromCandidate` 在同一事务内跑预算闸门，
 * 若在事务里调用全局 `prisma` 会另开连接，SQLite 写事务下会死锁。默认仍是全局客户端，
 * 现有调用方无需改动。
 */
type BudgetReader = typeof prisma | Prisma.TransactionClient;

/**
 * 类型转出（**不改既有 import 路径**）。
 *
 * `EffectiveBudget` / `WeekdayProfile` 的定义已经搬到 `domain/budget.ts`
 * （纯函数的返回值），但全项目有 5 处从本模块 import 它们。用重导出而不是改 5 个
 * import，是为了让这次"只搬实现、不搬 API"的改动足够小 —— 把一次语义修复
 * 变成一次无关的重构，评审就看不到真正的改动了。
 */
export type { EffectiveBudget, WeekdayProfile };

/** 读取 PlannerSettings（不存在时返回 null，由迁移或设置页创建）。 */
export async function getPlannerSettings(db: BudgetReader = prisma) {
  return db.plannerSettings.findUnique({ where: { id: 1 } });
}

/** 解析星期模板（实现已搬到 `domain/budget.ts`，这里只转出）。 */
export { parseWeekdayProfiles } from '@/lib/domain/budget';

/** 该日期的有效预算（薄壳：读 → `resolveEffectiveBudget` → 返回）。 */
export async function getEffectiveBudget(
  dateParam?: string,
  db: BudgetReader = prisma,
): Promise<EffectiveBudget> {
  const date = await resolveBusinessDate(dateParam);
  const [daily, settings] = await Promise.all([
    db.dailyBudget.findUnique({ where: { date } }),
    getPlannerSettings(db),
  ]);

  return resolveEffectiveBudget({ date, daily, settings });
}

/**
 * 区间内每一天的有效预算（周视图用；不产生数据库写入）。
 *
 * **与 `getEffectiveBudget` 共用同一个解析函数**，唯一的差别是批量读：
 * `DailyBudget` 一条 `IN` 查完，`PlannerSettings` 只读一次。
 * 这里不允许出现任何"未确认/模板为 0"的分支 —— 那些判断只在 `domain/budget.ts` 里。
 */
export async function getBudgetRange(
  dates: string[],
): Promise<Map<string, EffectiveBudget>> {
  const [dailyRows, settings] = await Promise.all([
    prisma.dailyBudget.findMany({ where: { date: { in: dates } } }),
    getPlannerSettings(),
  ]);
  const byDate = new Map(dailyRows.map((row) => [row.date, row]));

  const out = new Map<string, EffectiveBudget>();
  for (const date of dates) {
    out.set(date, resolveEffectiveBudget({ date, daily: byDate.get(date) ?? null, settings }));
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
