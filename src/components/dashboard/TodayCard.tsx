/**
 * Dashboard ③ 今日卡：按时长加权完成率（主）+ 任务数完成率（副）+ 剩余分钟 + 下一任务。
 */

import Link from 'next/link';
import { formatDurationZh, formatPercent } from '@/lib/format';
import type { DashboardDto } from '@/lib/types';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';

export function TodayCard({ data }: { data: DashboardDto['today'] }) {
  const hasTasks = data.totalTasks > 0;

  return (
    <Card
      title="今日"
      description="完成率以时长加权为主指标，任务数完成率仅为副指标。"
      actions={
        <Link href="/plan" className={buttonClass('secondary', 'sm')}>
          去计划页
        </Link>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border border-blue-200 bg-blue-50 p-2">
          <p className="text-[11px] text-inkMuted">完成率（按时长加权）</p>
          <p className="tabular text-lg font-semibold text-ink">
            {formatPercent(data.completionByTime)}
          </p>
          <p className="text-[11px] text-inkMuted">
            任务数完成率 {formatPercent(data.completionByCount)} · 已完成 {data.doneTasks}/
            {data.totalTasks}
          </p>
        </div>
        <div className="rounded-md border border-line bg-surfaceAlt p-2">
          <p className="text-[11px] text-inkMuted">剩余计划分钟</p>
          <p className="tabular text-lg font-semibold text-ink">
            {formatDurationZh(data.remainingMinutes)}
          </p>
          <p className="text-[11px] text-inkMuted">
            口径：未完成任务的（计划 − 实际）之和
          </p>
        </div>
      </div>

      {!hasTasks ? (
        <p className="mt-2 text-xs text-inkMuted">
          今天还没有计划任务。{' '}
          <Link href="/planner/build?horizon=1" className="text-brand hover:underline">
            去生成今日计划 →
          </Link>
        </p>
      ) : data.nextTask ? (
        <div className="mt-2 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href="/plan" className={buttonClass('primary', 'sm')}>
              <Icon name="play" size={12} />
              下一个任务：{data.nextTask.label}（{data.nextTask.plannedMinutes} 分钟）
            </Link>
            {data.nextTask.estimate && (
              <span className="text-[11px] text-inkMuted">
                估时 {data.nextTask.estimate.minMinutes}–{data.nextTask.estimate.maxMinutes} 分钟
                {data.nextTask.estimate.basis === 'CALIBRATED'
                  ? ` · 历史校准 ${data.nextTask.estimate.sampleCount} 样本`
                  : ' · 估计'}
              </span>
            )}
          </div>
          {data.nextTask.expectedOutput && (
            <p className="text-[11px] text-inkMuted">预期产出：{data.nextTask.expectedOutput}</p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-emerald-700">今天的任务都已完成。</p>
      )}
    </Card>
  );
}
