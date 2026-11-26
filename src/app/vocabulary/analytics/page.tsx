/**
 * `/vocabulary/analytics` 词汇时长与七维覆盖。
 *
 * 时长口径：effectiveSeconds（已扣与既有记录重叠的部分），分钟取整。
 */

import {
  VOCAB_DIMENSION_LABEL_ZH,
  VOCAB_PRACTICE_MODE_LABEL_ZH,
  type VocabDimension,
  type VocabPracticeMode,
} from '@/lib/constants';
import { businessToday } from '@/lib/businessTime';
import { addDays } from '@/lib/date';
import { getVocabAnalytics, getVocabRetestSummary } from '@/lib/queries/vocabIntegration';
import { Card } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export default async function VocabularyAnalyticsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const toRaw = one(params, 'to');
  const fromRaw = one(params, 'from');
  const to = isDate(toRaw) ? toRaw : await businessToday();
  const from = isDate(fromRaw) ? fromRaw : addDays(to, -29);

  const analytics = await getVocabAnalytics(from, to);
  const retests = await getVocabRetestSummary(from, to);
  const totalMinutes = analytics.dailyMinutes.reduce((sum, day) => sum + day.minutes, 0);
  const totalCorrect = analytics.accuracyTrend.reduce((sum, day) => sum + day.correct, 0);
  const totalIncorrect = analytics.accuracyTrend.reduce((sum, day) => sum + day.incorrect, 0);
  const totalAnswered = totalCorrect + totalIncorrect;
  const maxMinutes = Math.max(1, ...analytics.dailyMinutes.map((day) => day.minutes));
  const newTotal = analytics.newPerDay.reduce((sum, day) => sum + day.count, 0);

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">词汇分析</h1>
          <p className="text-xs text-inkMuted">
            {from} 至 {to} · 只统计已导入的练习会话
          </p>
        </div>
        <form method="get" className="flex flex-wrap items-end gap-1.5 text-[11px] text-inkMuted">
          <label className="flex flex-col gap-1">
            从
            <input
              type="date"
              name="from"
              defaultValue={from}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            />
          </label>
          <label className="flex flex-col gap-1">
            到
            <input
              type="date"
              name="to"
              defaultValue={to}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            />
          </label>
          <button type="submit" className="rounded-md border border-line bg-white px-2.5 py-1 text-xs text-ink">
            刷新
          </button>
        </form>
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile label="词汇净时长" value={totalMinutes} unit="分钟" tone="actual" />
        <StatTile label="会话数" value={analytics.dailyMinutes.reduce((sum, day) => sum + day.sessions, 0)} unit="次" />
        <StatTile
          label="新词条"
          value={newTotal}
          unit="个"
          tone="plan"
          hint="按词条创建日期统计"
        />
        <StatTile
          label="尝试正确率"
          value={totalAnswered > 0 ? `${Math.round((totalCorrect / totalAnswered) * 1000) / 10}%` : '—'}
          tone="output"
          hint={totalAnswered > 0 ? `对 ${totalCorrect} / 共 ${totalAnswered}` : '汇总会话没有逐词结果'}
        />
      </div>

      <Card title="每日词汇时长" description="同一时间段与其它学习记录重叠的部分已扣除">
        <div className="space-y-1">
          {analytics.dailyMinutes.map((day) => (
            <div key={day.date} className="flex items-center gap-2 text-[11px]">
              <span className="tabular w-20 shrink-0 text-inkMuted">{day.date.slice(5)}</span>
              <div className="h-2 flex-1 rounded bg-surfaceAlt">
                <div
                  className="h-2 rounded bg-emerald-500"
                  style={{ width: `${Math.round((day.minutes / maxMinutes) * 100)}%` }}
                />
              </div>
              <span className="tabular w-16 shrink-0 text-right text-inkMuted">
                {day.minutes} 分 · {day.sessions} 次
              </span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-2 lg:grid-cols-2">
        <Card title="模式分布" description="来自会话 mode；汇总统计没有模式时记为 MIXED">
          {analytics.modeMinutes.length === 0 ? (
            <p className="text-xs text-inkMuted">暂无数据。</p>
          ) : (
            <ul className="space-y-1 text-[11px]">
              {analytics.modeMinutes.map((entry) => (
                <li key={entry.mode} className="flex items-center justify-between">
                  <span className="text-ink">
                    {VOCAB_PRACTICE_MODE_LABEL_ZH[entry.mode as VocabPracticeMode] ?? entry.mode}
                  </span>
                  <span className="tabular text-inkMuted">{entry.minutes} 分钟</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="七维覆盖" description="能回忆 / 能语境理解 / 能产出使用 三个更高档位分开统计">
          <ul className="space-y-1 text-[11px]">
            {analytics.dimensionCoverage.map((entry) => (
              <li key={entry.dimension} className="flex items-center justify-between">
                <span className="text-ink">
                  {VOCAB_DIMENSION_LABEL_ZH[entry.dimension as VocabDimension] ?? entry.dimension}
                </span>
                <span className="tabular text-inkMuted">
                  已验证 {entry.verified} · 已接触 {entry.introduced}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="延迟复测" description="维度到「能回忆」后自动排 1 / 7 / 30 天复测；到期后记一条同维度证据即结清">
        <div className="grid grid-cols-3 gap-2">
          <StatTile label="待完成" value={retests.pending} unit="条" tone="plan" />
          <StatTile label="已到期" value={retests.due} unit="条" tone={retests.due > 0 ? 'warn' : 'neutral'} />
          <StatTile label="区间内完成" value={retests.completedInRange} unit="条" tone="mastery" />
        </div>
        {retests.upcoming.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-[11px]">
            {retests.upcoming.map((entry, index) => (
              <li
                key={`${entry.dueDate}-${entry.dimension}-${index}`}
                className="flex items-center justify-between border-b border-line pb-0.5 last:border-b-0"
              >
                <span className="text-ink">
                  {VOCAB_DIMENSION_LABEL_ZH[entry.dimension as VocabDimension] ?? (entry.dimension || '—')}
                </span>
                <span className="tabular text-inkMuted">
                  {entry.dueDate} · {entry.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="计划 vs 实际" description="计划取当日词汇任务的预计分钟数；实际取净时长">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-surfaceAlt text-inkMuted">
              <tr>
                <th className="px-2 py-1 text-left">日期</th>
                <th className="px-2 py-1 text-right">计划</th>
                <th className="px-2 py-1 text-right">实际</th>
                <th className="px-2 py-1 text-right">偏差</th>
              </tr>
            </thead>
            <tbody>
              {analytics.planningVsActual.map((row) => (
                <tr key={row.date} className="border-t border-line">
                  <td className="px-2 py-1">{row.date}</td>
                  <td className="px-2 py-1 tabular text-right">{row.planned} 分</td>
                  <td className="px-2 py-1 tabular text-right">{row.actual} 分</td>
                  <td className="px-2 py-1 tabular text-right">
                    {row.actual - row.planned > 0 ? '+' : ''}
                    {row.actual - row.planned} 分
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
