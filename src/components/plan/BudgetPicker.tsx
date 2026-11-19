'use client';

/**
 * 当日时间预算选择器（v2.1）。
 *
 * 三种入口：预设档（15→240）、自定义分钟、休息日。
 * 预算的**来源**必须可见：未确认的初始建议会明确标成「建议」，
 * 不能让用户误以为系统已经知道自己今天有多少时间。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setBudgetAction } from '@/lib/actions/budget';
import { generateAdaptivePlanAction } from '@/lib/actions/plan';
import { replanDailyTasksAction } from '@/lib/actions/replan';
import {
  BUDGET_INITIAL_SUGGESTION,
  BUDGET_PRESET_MINUTES,
  BUDGET_TIER_CODES,
  MIN_TASK_MINUTES,
  tierCodeOf,
  tierLabelZh,
} from '@/lib/constants';
import { buttonClass } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { inputClass } from '@/components/ui/FormField';
import type { PlanBudgetDto } from '@/lib/types';

export interface BudgetPickerProps {
  planDate: string;
  budget: PlanBudgetDto;
  hasTasks: boolean;
  /** 当日已发生净学习分钟（Σ 计时段日拆分，与重排引擎同口径），仅用于展示与幂等键。 */
  actualMinutesToday: number;
  planVersionCount: number;
  onToast: (message: string, tone: 'success' | 'error') => void;
}

const SOURCE_LABEL: Record<PlanBudgetDto['source'], string> = {
  USER: '已由你设定',
  WEEKDAY_TEMPLATE: '按星期模板',
  DEFAULT_SUGGESTION: '系统建议',
  MIGRATION: '迁移值',
};

/** 重排请求的幂等键：同一天同一预算同一分钟只排一次。 */
function makeIdempotencyKey(planDate: string, minutes: number, actualMinutes: number): string {
  return `replan:${planDate}:${minutes}:${actualMinutes}`;
}

export function BudgetPicker({
  planDate,
  budget,
  hasTasks,
  actualMinutesToday,
  planVersionCount,
  onToast,
}: BudgetPickerProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [minutes, setMinutes] = useState(
    budget.isRestDay ? 0 : budget.minutes || BUDGET_INITIAL_SUGGESTION,
  );
  const [custom, setCustom] = useState(
    BUDGET_PRESET_MINUTES.includes(minutes) ? '' : String(minutes),
  );
  const [note, setNote] = useState('');

  const isPreset = BUDGET_PRESET_MINUTES.includes(minutes);
  const dirty = minutes !== budget.minutes;

  const apply = () => {
    startTransition(async () => {
      const saved = await setBudgetAction({ date: planDate, minutes, note: note || undefined });
      if (!saved.ok) {
        onToast(saved.error, 'error');
        return;
      }

      // 已有任务：改预算＝重排，而不是再生成一遍
      if (hasTasks) {
        const replanned = await replanDailyTasksAction({
          planDate,
          newBudgetMinutes: minutes,
          reason: note || `当日预算调整为 ${minutes} 分钟`,
          idempotencyKey: makeIdempotencyKey(planDate, minutes, actualMinutesToday),
        });
        if (!replanned.ok) {
          onToast(replanned.error, 'error');
          return;
        }
        const { shrunkCount, deletedCount, newCount, warnings } = replanned.data;
        onToast(
          `已按 ${minutes} 分钟重排：保留 ${replanned.data.keptCount}、缩减 ${shrunkCount}、` +
            `延期 ${deletedCount}、新增 ${newCount}${warnings.length > 0 ? ` · ${warnings[0]}` : ''}`,
          'success',
        );
        router.refresh();
        return;
      }

      // 没有任务：直接按预算生成
      const generated = await generateAdaptivePlanAction({ planDate, dailyMinutes: minutes });
      if (!generated.ok) {
        onToast(generated.error, 'error');
        return;
      }
      const warnings = generated.data.warnings;
      onToast(
        warnings.length > 0
          ? `已按 ${minutes} 分钟生成 · ${warnings[0]}`
          : `已按 ${minutes} 分钟生成 ${generated.data.taskCount} 个任务`,
        'success',
      );
      router.refresh();
    });
  };

  const regenerate = () => {
    startTransition(async () => {
      const generated = await generateAdaptivePlanAction({ planDate, dailyMinutes: minutes });
      if (!generated.ok) {
        onToast(generated.error, 'error');
        return;
      }
      onToast(`已重新生成 ${generated.data.taskCount} 个任务`, 'success');
      router.refresh();
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-ink">今日可用时间</span>
        <select
          value={isPreset ? String(minutes) : 'CUSTOM'}
          disabled={pending}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'CUSTOM') {
              setCustom(isPreset ? String(minutes) : custom);
              return;
            }
            const next = Number(value);
            setMinutes(next);
            setCustom('');
          }}
          className={`${inputClass} w-40 py-1 text-xs`}
          aria-label="预设时间档"
        >
          {BUDGET_PRESET_MINUTES.map((preset) => (
            <option key={preset} value={preset}>
              {preset} 分钟 · {tierLabelZh(tierCodeOf(preset))}
            </option>
          ))}
          <option value="0">休息日（0 分钟）</option>
          <option value="CUSTOM">自定义…</option>
        </select>

        {!isPreset || minutes === 0 ? (
          <label className="flex items-center gap-1 text-[11px] text-inkMuted">
            自定义
            <input
              type="number"
              min={0}
              max={600}
              step={MIN_TASK_MINUTES}
              value={custom}
              disabled={pending}
              onChange={(event) => {
                setCustom(event.target.value);
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next >= 0) setMinutes(next);
              }}
              className={`${inputClass} w-20 py-1 text-xs`}
              aria-label="自定义分钟数"
            />
            分钟
          </label>
        ) : null}

        <input
          value={note}
          disabled={pending}
          onChange={(event) => setNote(event.target.value)}
          placeholder="调整原因（可选，写入审计）"
          maxLength={500}
          className={`${inputClass} min-w-[180px] flex-1 py-1 text-xs`}
          aria-label="预算调整原因"
        />

        <button
          type="button"
          onClick={apply}
          disabled={pending || (!dirty && hasTasks)}
          className={buttonClass('primary', 'sm')}
          title={
            hasTasks
              ? '按新预算重排未完成任务（已完成与已发生记录不改动）'
              : '按该预算生成今日计划'
          }
        >
          <Icon name={hasTasks ? 'repeat' : 'plus'} size={12} />
          {pending ? '处理中…' : hasTasks ? '按新预算重排' : '按此预算生成'}
        </button>

        {hasTasks && (
          <button
            type="button"
            onClick={regenerate}
            disabled={pending}
            className={buttonClass('secondary', 'sm')}
            title="清空未开始任务后按当前预算重新生成"
          >
            重新生成
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-inkMuted">
        <span
          className={[
            'rounded px-1.5 py-0.5',
            budget.isSuggestion
              ? 'border border-amber-300 bg-amber-50 text-amber-900'
              : 'border border-line bg-surfaceAlt',
          ].join(' ')}
        >
          当前预算 {budget.minutes} 分钟 · {SOURCE_LABEL[budget.source]}
          {budget.isSuggestion ? '（尚未确认，不是真实可用时间）' : ''}
        </span>
        {budget.isRestDay && <span>休息日：不生成强制任务，不计为学习失败</span>}
        {planVersionCount > 1 && <span>今日已调整 {planVersionCount} 个计划版本</span>}
        {actualMinutesToday > 0 && (
          <span className="text-emerald-700">
            已发生 {actualMinutesToday} 分钟 · 改预算只重排剩余部分
          </span>
        )}
        {budget.tierCode && <span>档位：{tierLabelZh(budget.tierCode)}</span>}
      </div>

      {minutes > 0 && minutes < 15 && (
        <p className="text-[11px] text-inkMuted">
          少于 15 分钟属于微学习 / 维护模式，只保证记忆连续性，不算完整学习日。
        </p>
      )}
      {minutes > 0 && !BUDGET_TIER_CODES.includes(tierCodeOf(minutes)) && (
        <p className="text-[11px] text-inkMuted">
          {minutes} 分钟为自定义档，不会被改写成最近的预设档。
        </p>
      )}
    </div>
  );
}
