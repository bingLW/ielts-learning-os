'use client';

/**
 * 计划页工具栏：日期导航 + 周条带 + 生成计划。
 *
 * 「预览当日计划」跳转统一 Planner；本页不再直接生成或写入计划。
 */

import Link from 'next/link';
import { useState } from 'react';
import { BUDGET_PRESET_MINUTES } from '@/lib/constants';
import { addDays } from '@/lib/date';
import { formatDurationZh } from '@/lib/format';
import { buttonClass } from '@/components/ui/Button';
import { FormField, inputClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';

export interface WeekStripDayView {
  date: string;
  plannedMinutes: number;
  netMinutes: number;
  taskCount: number;
  doneCount: number;
}

export interface PlanToolbarProps {
  planDate: string;
  todayStr: string;
  weekStrip: WeekStripDayView[];
  dailyMinutesPreset: number;
  hasTasks: boolean;
}

/** 生成计划按钮（工具栏与空态共用同一实现）。 */
export function GeneratePlanButton({
  planDate,
  dailyMinutesPreset,
  hasTasks,
  size = 'md',
}: {
  planDate: string;
  dailyMinutesPreset: number;
  hasTasks: boolean;
  size?: 'sm' | 'md';
}) {
  const [dailyMinutes, setDailyMinutes] = useState(dailyMinutesPreset);
  const href = hasTasks
    ? `/planner/replan?date=${encodeURIComponent(planDate)}`
    : `/planner/build?horizon=1&date=${encodeURIComponent(planDate)}&budget=${dailyMinutes}`;

  return (
    <div className="flex flex-wrap items-end gap-1.5">
      <FormField label="可用分钟" htmlFor="generate-minutes" className="w-24">
        <select
          id="generate-minutes"
          value={dailyMinutes}
          onChange={(event) => setDailyMinutes(Number(event.target.value))}
          className={`${inputClass} py-1 text-xs`}
        >
          <option value={0}>休息日 0</option>
          {BUDGET_PRESET_MINUTES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes}
            </option>
          ))}
          {!BUDGET_PRESET_MINUTES.includes(dailyMinutes) && dailyMinutes > 0 && (
            <option value={dailyMinutes}>{dailyMinutes}（自定义）</option>
          )}
        </select>
      </FormField>
      <Link
        href={href}
        className={buttonClass('primary', size)}
        title={hasTasks ? '进入统一重排预览' : '进入统一计划构建，预览确认后才写库'}
      >
        <Icon name={hasTasks ? 'repeat' : 'plus'} size={13} />
        {hasTasks ? '预览重排' : '预览当日计划'}
      </Link>
    </div>
  );
}

export function PlanToolbar({
  planDate,
  todayStr,
  weekStrip,
  dailyMinutesPreset,
  hasTasks,
}: PlanToolbarProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Link href={`/plan?date=${addDays(planDate, -1)}`} className={buttonClass('secondary', 'sm')}>
            ← 前一天
          </Link>
          <Link href={`/plan?date=${todayStr}`} className={buttonClass('secondary', 'sm')}>
            今天
          </Link>
          <Link href={`/plan?date=${addDays(planDate, 1)}`} className={buttonClass('secondary', 'sm')}>
            后一天 →
          </Link>
        </div>
        <GeneratePlanButton
          planDate={planDate}
          dailyMinutesPreset={dailyMinutesPreset}
          hasTasks={hasTasks}
        />
      </div>

      <div className="scroll-x">
        <ul className="flex min-w-full gap-1.5">
          {weekStrip.map((day) => {
            const active = day.date === planDate;
            return (
              <li key={day.date} className="min-w-[86px] flex-1">
                <Link
                  href={`/plan?date=${day.date}`}
                  className={[
                    'block rounded-md border px-2 py-1.5 text-center',
                    active ? 'border-brand bg-blue-50' : 'border-line bg-surface hover:bg-surfaceAlt',
                  ].join(' ')}
                >
                  <div className="tabular text-[11px] font-medium text-ink">{day.date.slice(5)}</div>
                  <div className="tabular text-[10px] text-inkMuted">
                    计划 {day.plannedMinutes}
                  </div>
                  <div className="tabular text-[10px] text-emerald-700">
                    净 {formatDurationZh(day.netMinutes)}
                  </div>
                  <div className="tabular text-[10px] text-inkMuted">
                    {day.doneCount}/{day.taskCount} 完成
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
