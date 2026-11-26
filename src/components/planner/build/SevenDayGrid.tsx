/**
 * 7 天网格：预览态按天展示草稿任务。
 *
 * 这里读的是**预览草稿**（`BuildPlanResult['days']`），不是已落库计划；
 * 所以每格都标「草稿」，避免用户误以为已经写进了今天。
 */

import { MODULE_META } from '@/lib/constants';
import type { ModuleId } from '@/lib/types';
import type { BuildPlanResult } from '@/lib/services/planBuild';

export function SevenDayGrid({ days }: { days: BuildPlanResult['days'] }) {
  if (days.length === 0) {
    return <p className="text-xs text-inkMuted">本次预览没有产生任何任务。</p>;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      {days.map((day) => (
        <div key={day.date} className="rounded-md border border-line">
          <div className="border-b border-line bg-surfaceAlt px-2 py-1">
            <p className="text-[11px] font-medium text-ink">{day.date}</p>
            <p className="text-[10px] text-inkMuted">
              {day.isRestDay ? '休息日' : `预算 ${day.budgetMinutes} 分钟`} · {day.tasks.length} 项
            </p>
          </div>
          {day.tasks.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-inkMuted">无任务</p>
          ) : (
            <ul className="space-y-1 px-2 py-1.5">
              {day.tasks.map((task, index) => (
                <li key={`${day.date}:${index}`} className="text-[11px]">
                  <span className="text-ink">{MODULE_META[task.module as ModuleId]?.labelZh ?? task.module}</span>
                  <span className="ml-1 text-inkMuted">
                    {task.priority} · {task.plannedMinutes} 分钟
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}