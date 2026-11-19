'use client';

/**
 * 计划页工具栏：日期导航 + 周条带 + 生成计划。
 *
 * 「生成当日计划」是幂等的：当日已有任务时服务端返回 `CONFLICT`，不会产生重复行。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { generateAdaptivePlanAction } from '@/lib/actions/plan';
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
  onToast: (message: string, tone: 'success' | 'error') => void;
}

/** 生成计划按钮（工具栏与空态共用同一实现）。 */
export function GeneratePlanButton({
  planDate,
  dailyMinutesPreset,
  hasTasks,
  onToast,
  size = 'md',
}: {
  planDate: string;
  dailyMinutesPreset: number;
  hasTasks: boolean;
  onToast: (message: string, tone: 'success' | 'error') => void;
  size?: 'sm' | 'md';
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dailyMinutes, setDailyMinutes] = useState(dailyMinutesPreset);

  const generate = () => {
    startTransition(async () => {
      const result = await generateAdaptivePlanAction({ planDate, dailyMinutes });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      const warnings = result.data.warnings;
      onToast(
        warnings.length > 0
          ? `${result.data.taskCount} 个任务已生成 · ${warnings[0]}`
          : `已生成 ${result.data.taskCount} 个任务，合计 ${result.data.totalMinutes} 分钟`,
        'success',
      );
      router.refresh();
    });
  };

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
      <button
        type="button"
        onClick={generate}
        disabled={pending || hasTasks}
        className={buttonClass('primary', size)}
        title={hasTasks ? '当日已有计划，未重复生成' : '按所选预算自适应生成计划'}
      >
        <Icon name="plus" size={13} />
        {pending ? '生成中…' : hasTasks ? '当日已有计划' : '生成当日计划'}
      </button>
    </div>
  );
}

export function PlanToolbar({
  planDate,
  todayStr,
  weekStrip,
  dailyMinutesPreset,
  hasTasks,
  onToast,
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
          onToast={onToast}
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
