'use client';

/**
 * `/planner/budget` 主体：7 天网格 + 档位选择 + 影响预览 + 双口径说明。
 *
 * 三个不可省的说明（PRD §4.6）：
 * 1. **首次安装的 60 分钟是建议值**，不是用户真实可用时间；
 * 2. **周总量（WeeklyTarget）不参与实际预算解析**，实际生效的是每日分配；
 *    两者不一致时给出「压缩每日分配 / 提高周目标」二选一，而不是静默取一方；
 * 3. **改预算不自动重排**，必须去重排预览确认。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDurationZh } from '@/lib/format';
import { setBudgetAction, setWeeklyTargetAction } from '@/lib/actions/budget';
import type { BudgetWeekDto, WeeklyTargetSummaryDto } from '@/lib/queries/planner';
import { BudgetImpactPreview } from './BudgetImpactPreview';
import { TierPicker } from './TierPicker';
import { WeekGrid } from './WeekGrid';

function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function BudgetPlannerBody({
  week,
  target,
  asOfDate,
}: {
  week: BudgetWeekDto;
  target: WeeklyTargetSummaryDto;
  asOfDate: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedDate, setSelectedDate] = useState(() => {
    const editable = week.days.find((day) => day.date >= asOfDate);
    return editable?.date ?? week.days[0]?.date ?? asOfDate;
  });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<{ date: string; minutes: number } | null>(null);
  const [targetDraft, setTargetDraft] = useState(
    target.targetMinutes === null ? '' : String(target.targetMinutes),
  );

  const selected = week.days.find((day) => day.date === selectedDate) ?? week.days[0];

  const applyBudget = (minutes: number) => {
    if (!selected) return;
    setError(null);
    setMessage(null);
    setLastChange(null);
    startTransition(async () => {
      const result = await setBudgetAction({ date: selected.date, minutes });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLastChange({ date: selected.date, minutes });
      setMessage(
        `已更新 ${selected.date} 的预算为 ${minutes} 分钟。预算变更不会自动重排计划，请到重排预览确认。`,
      );
      router.refresh();
    });
  };

  const applyWorkdays = (minutes: number) => {
    setError(null);
    setMessage(null);
    setLastChange(null);
    const dates = week.days
      .filter((day) => day.date >= asOfDate)
      .filter((day) => !day.isRestDay && weekdayIndex(day.date) >= 1 && weekdayIndex(day.date) <= 5)
      .map((day) => day.date);
    if (dates.length === 0) {
      setError('本周没有可修改的未来工作日');
      return;
    }
    startTransition(async () => {
      for (const date of dates) {
        const result = await setBudgetAction({ date, minutes });
        if (!result.ok) {
          setError(`${date}：${result.error}`);
          return;
        }
      }
      setLastChange({ date: dates[0]!, minutes });
      setMessage(
        `已把本周 ${dates.length} 个未来工作日设为 ${minutes} 分钟。不会自动重排，请到重排预览确认。`,
      );
      router.refresh();
    });
  };

  const saveTarget = () => {
    const parsed = Number(targetDraft);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setError('周目标必须是大于 0 的整数分钟');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await setWeeklyTargetAction({
        weekStart: target.weekStart,
        targetMinutes: parsed,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(`周目标已保存为 ${parsed} 分钟（只作参考，不改变每日分配）。`);
      router.refresh();
    });
  };

  const allocatedSum = week.totals.budgetMinutes;
  const targetMinutes = target.targetMinutes;
  const targetBelowAllocation = targetMinutes !== null && allocatedSum > targetMinutes;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">时间预算</h1>
          <p className="text-xs text-inkMuted">
            {week.weekStart} ~ {week.weekEnd} · 基准日 {asOfDate} · 每日分配合计{' '}
            {formatDurationZh(allocatedSum)}
          </p>
        </div>
        <Link href={`/planner/replan?date=${selectedDate}`} className="text-xs text-brand">
          去重排预览 →
        </Link>
      </header>

      {week.isFirstInstallSuggestion && (
        <div
          data-testid="first-install-notice"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <p className="font-medium">当前 60 分钟是建议值，不是你真实可用的时间</p>
          <p className="mt-0.5">
            这是首次安装的默认建议，还没有经过你确认。请按真实可用时间调整下面的每日预算；
            未确认前，计划页也会把它标注为「建议」。
          </p>
        </div>
      )}

      <Card
        title="本周 7 天预算"
        description="选中一天调整档位；已发生日期只读，改预算只影响该天及之后。"
      >
        <div id="budget-grid">
          <WeekGrid
            week={week}
            selectedDate={selectedDate}
            asOfDate={asOfDate}
            onSelect={setSelectedDate}
          />
        </div>
        {selected && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium text-ink">
                调整 {selected.date}（当前 {selected.isRestDay ? '休息日' : `${selected.budgetMinutes} 分`}
                ）
              </p>
              {pending && <span className="text-[11px] text-inkMuted">提交中…</span>}
            </div>
            <TierPicker
              date={selected.date}
              currentMinutes={selected.budgetMinutes}
              isRestDay={selected.isRestDay}
              asOfDate={asOfDate}
              pending={pending}
              onApply={applyBudget}
              onApplyWorkdays={applyWorkdays}
            />
          </div>
        )}

        {lastChange && (
          <div className="mt-2">
            <BudgetImpactPreview
              week={week}
              changeDate={lastChange.date}
              changeMinutes={lastChange.minutes}
              asOfDate={asOfDate}
            />
          </div>
        )}

        <div
          data-testid="no-auto-replan"
          className="mt-2 rounded-md border border-line bg-surfaceAlt px-2.5 py-1.5 text-[11px] text-inkMuted"
        >
          预算修改不会自动重排计划，也不会按比例裁剪任务；需要重排时请前往{' '}
          <Link href={`/planner/replan?date=${selectedDate}`} className="text-brand underline">
            重排预览
          </Link>{' '}
          并确认。
        </div>
      </Card>

      <Card
        title="周总量 vs 每日分配（双口径）"
        description="实际生效的是每日分配；周总量只是目标参考，不参与预算解析"
      >
        <p data-testid="dual-basis-note" className="text-[11px] text-inkMuted">
          每日分配之和 = {formatDurationZh(allocatedSum)}；周总量（WeeklyTarget）=
          {targetMinutes === null ? '未设置' : formatDurationZh(targetMinutes)}。
          WeeklyTarget 不参与实际预算解析，页面与计划生成都以每日分配（DailyBudget）为准。
        </p>

        {targetBelowAllocation && (
          <div
            data-testid="target-conflict"
            className="mt-2 rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800"
          >
            <p className="font-medium">
              周总量 {formatDurationZh(targetMinutes)} 小于每日分配之和{' '}
              {formatDurationZh(allocatedSum)}
            </p>
            <p className="mt-0.5">
              两者不会自动取一方。请二选一：下调每日分配使合计不超过周总量，或提高周目标使其不低于每日分配之和。
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              <a href="#weekly-target" className="font-medium underline">
                提高周目标
              </a>
              <a href="#budget-grid" className="font-medium underline">
                按周总量压缩每日分配
              </a>
            </div>
          </div>
        )}

        <div id="weekly-target" className="mt-2 flex flex-wrap items-end gap-1.5">
          <label htmlFor="weekly-target-input" className="text-[11px] text-inkMuted">
            周目标（分钟）
          </label>
          <input
            id="weekly-target-input"
            type="number"
            min={1}
            value={targetDraft}
            onChange={(event) => setTargetDraft(event.target.value)}
            className="w-24 rounded border border-line bg-white px-2 py-1 text-[11px] text-ink"
          />
          <Button variant="secondary" size="sm" onClick={saveTarget} disabled={pending}>
            保存周目标
          </Button>
          {target.source && (
            <span className="text-[11px] text-inkMuted">
              当前来源 {target.source} · 状态 {target.status ?? '—'}
            </span>
          )}
        </div>
      </Card>

      {message && (
        <p className="rounded-md border border-green-300 bg-green-50 px-2.5 py-1.5 text-[11px] text-green-800">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}