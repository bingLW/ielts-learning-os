'use client';

/**
 * 周复盘主体（T29）。
 *
 * 13 项指标：左侧是系统算出的 auto 值（只读），右侧可填「手工覆盖」。
 * 覆盖是**双写**：auto 与 override 都保留，导出时用 effective 值并标注是否被覆盖。
 * Top3 薄弱点必须填满 3 项，否则保存会被拒（服务端也再校验一次）。
 */

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  buildWeeklyTextAction,
  markWeeklyExportedAction,
  saveWeeklyReviewAction,
} from '@/lib/actions/weekly';
import { WEEKLY_TOP3_COUNT } from '@/lib/constants';
import { formatDurationZh } from '@/lib/format';
import type {
  TrackStatDto,
  WeeklyBudgetDto,
  WeeklyReviewDto,
  WeeklyTop3Dto,
  WeeklyWeekOptionDto,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField, inputClass, textareaClass } from '@/components/ui/FormField';
import { StatTile } from '@/components/ui/StatTile';
import { TagBadge } from '@/components/ui/StatusBadge';
import { Toast, useToastState } from '@/components/ui/Toast';

export interface WeeklyPageBodyProps {
  review: WeeklyReviewDto;
  options: WeeklyWeekOptionDto[];
  suggestions: string[];
  isCurrentWeek: boolean;
  /** v2.0：本周三轨道净时长（独立统计，不合并总分）。 */
  trackStats: TrackStatDto[];
  /** v2.1：本周预算 / 实际 / 重排记录。 */
  budget: WeeklyBudgetDto;
}

/** 指标 → 是否属于「长期趋势」类（用于分组展示）。 */
const TREND_KEYS = new Set([
  'WEEK_OVER_WEEK',
  'COLOR_DELTA',
  'COMPLETION_RATE',
  'DAILY_DISTRIBUTION',
]);

export function WeeklyPageBody({
  review,
  options,
  suggestions,
  isCurrentWeek,
  trackStats,
  budget,
}: WeeklyPageBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();

  const [overrides, setOverrides] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const metric of review.metrics) {
      initial[metric.key] = metric.overrideValue ?? '';
    }
    return initial;
  });
  const [top3, setTop3] = useState<WeeklyTop3Dto[]>(() => {
    const base = review.top3.slice(0, WEEKLY_TOP3_COUNT);
    while (base.length < WEEKLY_TOP3_COUNT) {
      base.push({ name: '', score: 0, evidence: '', manual: true });
    }
    return base;
  });
  const [note, setNote] = useState(review.reviewNote ?? '');

  const setTop3Field = (index: number, patch: Partial<WeeklyTop3Dto>) => {
    setTop3((current) =>
      current.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
  };

  const save = () => {
    startTransition(async () => {
      const result = await saveWeeklyReviewAction({
        isoYear: review.isoYear,
        isoWeek: review.isoWeek,
        weekStart: review.weekStart,
        weekEnd: review.weekEnd,
        isPartial: review.isPartial,
        metrics: review.metrics.map((metric) => ({
          key: metric.key,
          autoValue: metric.autoValue,
          overrideValue: overrides[metric.key] ?? '',
        })),
        top3,
        reviewNote: note || undefined,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('周复盘已保存', 'success');
      router.refresh();
    });
  };

  const exportText = () => {
    startTransition(async () => {
      const result = await buildWeeklyTextAction({
        isoYear: review.isoYear,
        isoWeek: review.isoWeek,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      const blob = new Blob([result.data.text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.data.fileName;
      link.click();
      URL.revokeObjectURL(url);

      const marked = await markWeeklyExportedAction({
        isoYear: review.isoYear,
        isoWeek: review.isoWeek,
      });
      show(marked.ok ? '已导出并记录导出时间' : marked.error, marked.ok ? 'success' : 'error');
      router.refresh();
    });
  };

  const completionMetric = review.metrics.find((metric) => metric.key === 'COMPLETION_RATE');

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">
            周复盘 · {review.isoYear}-W{String(review.isoWeek).padStart(2, '0')}
            {isCurrentWeek && <span className="ml-1 text-[11px] text-inkMuted">（本周）</span>}
          </h1>
          <p className="text-xs text-inkMuted">
            {review.weekStart} ~ {review.weekEnd} ·{' '}
            {review.isPartial ? '不完整周（数据缺口或周未过完）' : '完整周'} ·{' '}
            {review.savedAt ? `上次保存 ${review.savedAt.slice(0, 10)}` : '尚未保存'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="secondary" size="sm" onClick={exportText} disabled={pending}>
            导出纯文本
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={pending}>
            {pending ? '保存中…' : '保存周复盘'}
          </Button>
        </div>
      </header>

      <Card title="切换周次" description="只列最近 10 周；已保存的周会有标记">
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => {
            const active = option.isoYear === review.isoYear && option.isoWeek === review.isoWeek;
            return (
              <Link
                key={`${option.isoYear}-${option.isoWeek}`}
                href={`/weekly?year=${option.isoYear}&week=${option.isoWeek}`}
                className={[
                  'rounded border px-2 py-1 text-[11px]',
                  active
                    ? 'border-brand bg-brand text-white'
                    : 'border-line bg-white text-ink hover:bg-surfaceAlt',
                ].join(' ')}
              >
                {option.label}
                {option.saved && <span className="ml-1">·</span>}
              </Link>
            );
          })}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile
          label="净学习时长"
          value={review.metrics.find((metric) => metric.key === 'NET_MINUTES')?.effectiveValue ?? '—'}
          tone="actual"
          scopeNote="跨零点已按分钟拆到两天"
        />
        <StatTile
          label="计划完成率"
          value={completionMetric?.effectiveValue ?? '—'}
          tone="plan"
          scopeNote="按时长加权（不是任务数占比）"
        />
        <StatTile
          label="三色环比"
          value={review.metrics.find((metric) => metric.key === 'COLOR_DELTA')?.effectiveValue ?? '—'}
          tone="mastery"
        />
        <StatTile
          label="下周 Top3"
          value={`${top3.filter((item) => item.name.trim().length > 0).length}/${WEEKLY_TOP3_COUNT}`}
          tone={top3.every((item) => item.name.trim().length > 0) ? 'actual' : 'warn'}
          hint="必须填满才能保存"
        />
      </div>

      <Card
        title="时间预算 vs 实际"
        description="预算按当日有效设定汇总（休息日计 0）；实际仍只从计时段的跨零点拆分求和，两者严格分列"
      >
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile
            label="本周预算合计"
            value={formatDurationZh(budget.budgetTotalMinutes)}
            tone="plan"
            hint={`${budget.budgetedDays} 个学习日 · ${budget.restDays} 个休息日`}
            scopeNote="休息日不计入预算分母"
          />
          <StatTile
            label="本周实际净时长"
            value={formatDurationZh(budget.netTotalMinutes)}
            tone="actual"
            scopeNote="Σ StudySessionDaySplit.minutes"
          />
          <StatTile
            label="预算利用率"
            value={
              budget.budgetTotalMinutes > 0
                ? `${Math.round((budget.netTotalMinutes / budget.budgetTotalMinutes) * 100)}%`
                : '—'
            }
            tone="output"
            scopeNote="实际 ÷ 预算；预算为 0 时显示 —"
          />
          <StatTile
            label="中途重排次数"
            value={String(budget.replanCount)}
            tone={budget.replanCount > 0 ? 'warn' : 'neutral'}
            hint="预算变化或计划调整留下的版本记录"
          />
        </div>

        {budget.days.some((day) => day.isSuggestion) && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
            本周有日期的预算仍标着「未确认的建议值」，不是真实可用时间。去计划页确认后，这里的分母才会准确。
          </p>
        )}

        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-[11px]">
            <thead>
              <tr className="border-b border-line text-inkMuted">
                <th className="py-1 text-left font-medium">日期</th>
                <th className="py-1 text-right font-medium">预算</th>
                <th className="py-1 text-right font-medium">计划</th>
                <th className="py-1 text-right font-medium">实际净时长</th>
                <th className="py-1 text-right font-medium">使用率</th>
              </tr>
            </thead>
            <tbody>
              {budget.days.map((day) => (
                <tr key={day.date} className="border-b border-line/60">
                  <td className="py-1 tabular">
                    {day.date.slice(5)}
                    {day.isRestDay && <span className="ml-1 text-inkMuted">休息</span>}
                    {day.isSuggestion && <span className="ml-1 text-amber-700">建议</span>}
                  </td>
                  <td className="py-1 text-right tabular">
                    {day.isRestDay ? '—' : formatDurationZh(day.budgetMinutes)}
                  </td>
                  <td className="py-1 text-right tabular">{formatDurationZh(day.plannedMinutes)}</td>
                  <td className="py-1 text-right tabular">{formatDurationZh(day.netMinutes)}</td>
                  <td className="py-1 text-right tabular">
                    {day.isRestDay || day.budgetMinutes <= 0
                      ? '—'
                      : `${Math.round((day.netMinutes / day.budgetMinutes) * 100)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {budget.target && (
          <p className="mt-2 text-[11px] text-inkMuted">
            周目标 {formatDurationZh(budget.target.targetMinutes)}（状态 {budget.target.status} ·
            来源 {budget.target.source}）
          </p>
        )}

        {budget.versions.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-inkMuted">
              查看 {budget.versions.length} 次重排明细
            </summary>
            <ul className="mt-1 space-y-1">
              {budget.versions.map((item) => (
                <li key={`${item.version}-${item.createdAt}`} className="text-[11px] text-inkMuted">
                  v{item.version} · {item.changeSource} · 预算 {item.budgetMinutes} 分 ·{' '}
                  {item.createdAt.slice(0, 16).replace('T', ' ')}
                  {item.reason ? ` · ${item.reason}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card
        title="三轨道净时长"
        description="三条轨道独立统计与验收，时长只计一次，不合并成一个总分"
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {trackStats.map((stat) => {
            const hasData = stat.minutes > 0;
            return (
              <div
                key={stat.track}
                className="rounded border border-line bg-white px-3 py-2.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-ink">{stat.labelZh}</span>
                  <span className="text-[11px] tabular text-inkMuted">
                    {stat.shareOfTotal != null ? `${Math.round(stat.shareOfTotal * 100)}%` : '—'}
                  </span>
                </div>
                <div className="mt-1 text-lg font-semibold tabular text-ink">
                  {hasData ? formatDurationZh(stat.minutes) : '—'}
                </div>
                <div className="text-[11px] text-inkMuted">
                  {hasData ? `${stat.sessionCount} 段学习` : '本周无记录'}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="13 项指标"
        description="左侧是系统值（只读），右侧可覆盖；覆盖后仍保留系统值（导出时会标注）"
      >
        <div className="space-y-1.5">
          {review.metrics.map((metric) => (
            <div
              key={metric.key}
              className="grid gap-1 rounded border border-line bg-white px-2.5 py-1.5 mobile:grid-cols-1 md:grid-cols-[minmax(140px,180px)_1fr_minmax(160px,240px)] md:items-center"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-medium text-ink">{metric.label}</span>
                {TREND_KEYS.has(metric.key) && <TagBadge>趋势</TagBadge>}
              </div>
              <p className="text-[11px] text-inkMuted">{metric.autoValue}</p>
              <input
                value={overrides[metric.key] ?? ''}
                onChange={(event) =>
                  setOverrides((current) => ({ ...current, [metric.key]: event.target.value }))
                }
                placeholder="手工覆盖（可留空）"
                aria-label={`${metric.label} 的手工覆盖值`}
                className="w-full rounded border border-line bg-white px-2 py-1 text-[11px] text-ink"
              />
            </div>
          ))}
        </div>
      </Card>

      <Card
        title={`下周 Top3 薄弱点（必须 ${WEEKLY_TOP3_COUNT} 项）`}
        description="依据写清楚，否则下周无法验证是否改善"
      >
        {suggestions.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            <span className="text-[11px] text-inkMuted">从高频知识点填充：</span>
            {suggestions.slice(0, 6).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => {
                  const emptyIndex = top3.findIndex((item) => item.name.trim().length === 0);
                  if (emptyIndex >= 0) setTop3Field(emptyIndex, { name, manual: true });
                }}
                className="rounded border border-line bg-surfaceAlt px-2 py-0.5 text-[11px] text-ink hover:bg-white"
              >
                {name}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {top3.map((item, index) => (
            <div key={index} className="grid gap-1.5 md:grid-cols-[minmax(120px,200px)_1fr]">
              <FormField label={`薄弱点 ${index + 1}`} htmlFor={`top3-name-${index}`}>
                <input
                  id={`top3-name-${index}`}
                  value={item.name}
                  onChange={(event) => setTop3Field(index, { name: event.target.value })}
                  placeholder="例如 定语从句关系词"
                  className={inputClass}
                />
              </FormField>
              <FormField label="依据 / 下周怎么验证改善" htmlFor={`top3-evidence-${index}`}>
                <input
                  id={`top3-evidence-${index}`}
                  value={item.evidence}
                  onChange={(event) => setTop3Field(index, { evidence: event.target.value })}
                  placeholder="例如 本周 8 道错题里 5 道是关系词选错"
                  className={inputClass}
                />
              </FormField>
            </div>
          ))}
        </div>
      </Card>

      <Card title="本周备注" description="写给人看的总结，不做任何自动解析">
        <FormField label="备注" htmlFor="weekly-note">
          <textarea
            id="weekly-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={textareaClass}
            placeholder="这周最大的问题是什么？下周只改一件事，改什么？"
          />
        </FormField>
      </Card>

      {review.metrics.every((metric) => metric.autoValue === '—') && (
        <EmptyState
          icon="chart"
          title="这一周几乎没有数据"
          description="周复盘的价值来自真实记录。先去记几笔学习记录、做几次复测，再回来看这里。"
          primary={{ label: '去记学习记录', href: '/records' }}
          secondary={{ label: '去复习中心', href: '/review' }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
