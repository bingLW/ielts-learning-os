/**
 * `/planner/budget`：一周预算规划（v2.7 T13）。
 *
 * 只读装配：预算来自 `getBudgetWeek`（`getBudgetRange` 唯一解析口），
 * 周目标来自 `getWeeklyTargetSummary`。页面上所有修改都走既有
 * `setBudgetAction` / `setWeeklyTargetAction`，这里不写库。
 */

import { isValidDateString, startOfIsoWeek, today } from '@/lib/date';
import { getBudgetWeek, getWeeklyTargetSummary } from '@/lib/queries/planner';
import { BudgetPlannerBody } from '@/components/planner/budget/BudgetPlannerBody';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ week?: string }>;
}

function parseWeekStart(raw: string | undefined, fallback: string): string {
  if (!raw || !isValidDateString(raw)) return fallback;
  // 任意日期都归一到该周周一，URL 手改成周三也不会出现「7 天错位」。
  return startOfIsoWeek(raw);
}

export default async function PlannerBudgetPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const asOfDate = today();
  const weekStart = parseWeekStart(params.week, startOfIsoWeek(asOfDate));

  const [week, target] = await Promise.all([
    getBudgetWeek(weekStart),
    getWeeklyTargetSummary(weekStart),
  ]);

  return <BudgetPlannerBody week={week} target={target} asOfDate={asOfDate} />;
}