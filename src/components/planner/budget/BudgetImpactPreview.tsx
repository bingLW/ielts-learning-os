/**
 * 改预算后的影响预览（估算，不写库）。
 *
 * 口径：从被改日期起的**未来**日期里，已排分钟超过（新）预算的天，
 * 视为「需要重排」；受影响任务数按这些天的已排任务数合计。
 * 这里不按比例裁剪、不假装知道会移走哪几条 —— 精确结果以重排预览为准。
 */

import Link from 'next/link';
import type { BudgetWeekDto } from '@/lib/queries/planner';

export function BudgetImpactPreview({
  week,
  changeDate,
  changeMinutes,
  asOfDate,
}: {
  week: BudgetWeekDto;
  changeDate: string;
  changeMinutes: number;
  asOfDate: string;
}) {
  const affected = week.days.filter((day) => {
    if (day.date < changeDate || day.date < asOfDate) return false;
    const budget = day.date === changeDate ? changeMinutes : day.budgetMinutes;
    if (budget <= 0) return false;
    return day.plannedMinutes > budget;
  });
  const affectedTasks = affected.reduce((sum, day) => sum + day.taskCount, 0);

  return (
    <div data-testid="budget-impact" className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
      <p className="font-medium">影响预览（估算）</p>
      <p className="mt-0.5">
        改后本周有 {affected.length} 天已排超出预算，预计 {affectedTasks} 条任务需要重新安排。
        改预算不会自动重排，也不会按比例裁剪任务。
      </p>
      <Link
        href={`/planner/replan?date=${changeDate}`}
        className="mt-1 inline-block text-[11px] font-medium text-brand underline"
      >
        查看重排预览 →
      </Link>
    </div>
  );
}