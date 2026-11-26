/**
 * `/planner/budget` 的一周 7 天网格。
 *
 * 只负责展示 + 选中：预算改动统一走 `TierPicker` → `setBudgetAction`，
 * 这里不出现第二次计算（超用判定直接用 query 给的 budget/planned/net）。
 */

import type { BudgetWeekDto } from '@/lib/queries/planner';

const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'];

function weekdayOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return WEEKDAY_LABEL[parsed.getUTCDay()] ?? '';
}

export function WeekGrid({
  week,
  selectedDate,
  asOfDate,
  onSelect,
}: {
  week: BudgetWeekDto;
  selectedDate: string;
  asOfDate: string;
  onSelect: (date: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[11px]">
        <thead>
          <tr className="border-b border-line text-inkMuted">
            <th className="py-1 text-left font-medium">日期</th>
            <th className="py-1 text-left font-medium">档位</th>
            <th className="py-1 text-right font-medium">预算</th>
            <th className="py-1 text-left font-medium">来源</th>
            <th className="py-1 text-right font-medium">已排</th>
            <th className="py-1 text-right font-medium">实际</th>
            <th className="py-1 text-left font-medium">状态</th>
            <th className="py-1 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {week.days.map((day) => {
            const selected = day.date === selectedDate;
            const isPast = day.date < asOfDate;
            const overBudget = !day.isRestDay && day.plannedMinutes > day.budgetMinutes;
            return (
              <tr
                key={day.date}
                data-testid={`budget-day-${day.date}`}
                className={[
                  'border-b border-line/60',
                  selected ? 'bg-surfaceAlt' : '',
                ].join(' ')}
              >
                <td className="py-1 tabular">
                  {day.date.slice(5)} 周{weekdayOf(day.date)}
                </td>
                <td className="py-1">{day.tierCode ?? '—'}</td>
                <td className="py-1 text-right tabular">
                  {day.isRestDay ? '休息' : `${day.budgetMinutes} 分`}
                </td>
                <td className="py-1 text-inkMuted">
                  {day.isRestDay
                    ? '休息日'
                    : day.isInitialSuggestion
                      ? '建议值（未确认）'
                      : day.source === 'USER'
                        ? '用户设定'
                        : '默认'}
                </td>
                <td className="py-1 text-right tabular">{day.plannedMinutes} 分</td>
                <td className="py-1 text-right tabular">{day.netMinutes} 分</td>
                <td className="py-1">
                  {isPast ? (
                    <span className="text-inkMuted">已发生（只读）</span>
                  ) : overBudget ? (
                    <span className="text-amber-800">已排超出预算</span>
                  ) : (
                    <span className="text-inkMuted">正常</span>
                  )}
                </td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    onClick={() => onSelect(day.date)}
                    disabled={isPast}
                    className="rounded border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-surfaceAlt disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    调整
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="text-ink">
            <td className="py-1 font-medium" colSpan={2}>
              合计
            </td>
            <td className="py-1 text-right tabular">{week.totals.budgetMinutes} 分</td>
            <td />
            <td className="py-1 text-right tabular">{week.totals.plannedMinutes} 分</td>
            <td className="py-1 text-right tabular">{week.totals.netMinutes} 分</td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}