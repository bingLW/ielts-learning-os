'use client';

/**
 * 单日预算档次选择器（15 / 30 / 45 / 60 / 90 / 120 / 180 / 240 / 自定义）。
 *
 * 只产出「选中的分钟数」，提交交给父组件的 `setBudgetAction`；
 * 已发生的日期（< asOfDate）不可改 —— 改预算只影响该天及之后。
 */

import { useState } from 'react';
import { BUDGET_MINUTES_MAX, BUDGET_MINUTES_MIN, BUDGET_TIERS } from '@/lib/constants';

export interface TierPickerProps {
  date: string;
  currentMinutes: number;
  isRestDay: boolean;
  asOfDate: string;
  pending: boolean;
  onApply: (minutes: number) => void;
  onApplyWorkdays: (minutes: number) => void;
}

export function TierPicker({
  date,
  currentMinutes,
  isRestDay,
  asOfDate,
  pending,
  onApply,
  onApplyWorkdays,
}: TierPickerProps) {
  const [custom, setCustom] = useState(String(currentMinutes > 0 ? currentMinutes : 60));
  const locked = date < asOfDate;

  if (locked) {
    return (
      <p className="rounded-md border border-line bg-surfaceAlt px-2.5 py-1.5 text-[11px] text-inkMuted">
        {date} 已发生，预算只读；修改预算只影响该天及之后。
      </p>
    );
  }

  const parsedCustom = Number(custom);
  const customValid =
    Number.isInteger(parsedCustom) &&
    parsedCustom >= BUDGET_MINUTES_MIN &&
    parsedCustom <= BUDGET_MINUTES_MAX;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {BUDGET_TIERS.map((tier) => {
          const active = tier.custom ? false : tier.minutes === currentMinutes && !isRestDay;
          return (
            <button
              key={tier.code}
              type="button"
              disabled={pending}
              onClick={() => {
                if (tier.custom) return;
                if (tier.minutes !== null) onApply(tier.minutes);
              }}
              title={tier.subLabelZh}
              className={[
                'rounded border px-2 py-1 text-[11px]',
                active
                  ? 'border-brand bg-brand text-white'
                  : 'border-line bg-white text-ink hover:bg-surfaceAlt',
                tier.custom ? 'cursor-default opacity-60' : '',
              ].join(' ')}
            >
              {tier.minutes === null ? '自定义 →' : `${tier.minutes} 分`}
              <span className="ml-1 text-[10px] opacity-70">{tier.labelZh}</span>
            </button>
          );
        })}
        <button
          type="button"
          disabled={pending}
          onClick={() => onApply(0)}
          className={[
            'rounded border px-2 py-1 text-[11px]',
            isRestDay
              ? 'border-brand bg-brand text-white'
              : 'border-line bg-white text-ink hover:bg-surfaceAlt',
          ].join(' ')}
        >
          休息日（0 分）
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <label className="text-[11px] text-inkMuted" htmlFor="custom-budget">
          自定义
        </label>
        <input
          id="custom-budget"
          type="number"
          min={BUDGET_MINUTES_MIN}
          max={BUDGET_MINUTES_MAX}
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          className="w-20 rounded border border-line bg-white px-2 py-1 text-[11px] text-ink"
        />
        <button
          type="button"
          disabled={pending || !customValid}
          onClick={() => onApply(parsedCustom)}
          className="rounded border border-line px-2 py-1 text-[11px] text-ink hover:bg-surfaceAlt disabled:opacity-50"
        >
          应用
        </button>
        <button
          type="button"
          disabled={pending || !customValid}
          onClick={() => onApplyWorkdays(parsedCustom)}
          className="rounded border border-line px-2 py-1 text-[11px] text-ink hover:bg-surfaceAlt disabled:opacity-50"
        >
          套用到本周末来的工作日
        </button>
      </div>
      <p className="text-[11px] text-inkMuted">
        修改只影响 {date} 及之后；已发生日期不会被改写。「套用工作日」也跳过已发生日期与休息日。
      </p>
    </div>
  );
}