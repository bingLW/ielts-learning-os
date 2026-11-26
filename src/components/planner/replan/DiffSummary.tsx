/**
 * 重排汇总：预算前后、已安排分钟前后、各类计数、backlog。
 *
 * `hasChanges=false` 时必须给出「没有变更」的明确结论，而不是让用户对着空 diff 猜。
 */

import type { ReplanDiff } from '@/lib/domain/planDiff';

export function DiffSummary({ diff }: { diff: ReplanDiff }) {
  const summary = diff.summary;
  return (
    <div data-testid="diff-summary" className="space-y-2 text-xs">
      <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-[11px] text-inkMuted">预算</dt>
          <dd className="text-ink">
            {summary.budgetBefore} → {summary.budget} 分钟
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-inkMuted">已安排</dt>
          <dd className="text-ink">
            {summary.plannedBefore} → {summary.plannedAfter} 分钟
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-inkMuted">P0 分钟</dt>
          <dd className="text-ink">
            {summary.p0MinutesBefore} → {summary.p0MinutesAfter} 分钟
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-inkMuted">挤出到 backlog</dt>
          <dd className="text-ink">{summary.backlogMinutes} 分钟</dd>
        </div>
      </dl>
      <p className="text-inkMuted">
        新增 {summary.addedCount} · 移除 {summary.removedCount} · 改期 {summary.movedCount} · 调整时长{' '}
        {summary.resizedCount} · 调优先级 {summary.priorityChangedCount} · 保持 {summary.keptCount}
        {summary.protectedMinutes > 0 ? ` · 受保护 ${summary.protectedMinutes} 分钟` : ''}
      </p>
      {!diff.hasChanges && (
        <p data-testid="no-changes" className="rounded-md bg-surfaceAlt px-2 py-1 text-ink">
          本次没有可确认的变更：所有任务都保持不变，不会生成空版本。
        </p>
      )}
      {diff.warnings.map((warning) => (
        <p key={warning} className="rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          {warning}
        </p>
      ))}
    </div>
  );
}