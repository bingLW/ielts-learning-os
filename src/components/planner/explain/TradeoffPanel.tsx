/**
 * 取舍区：被预算挤掉的任务、P0 / 核心 / 拓展配比、补测延后。
 *
 * 「被挤掉」展示的是**候选预计分钟**（`estMinutes`），标签必须写清口径 ——
 * 它不是计划分钟，混入会让比例与预算对不上（I-2）。
 */

import { Card } from '@/components/ui/Card';
import type { PlanExplanationDto } from '@/lib/queries/planner';

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function TradeoffPanel({ tradeoffs }: { tradeoffs: PlanExplanationDto['tradeoffs'] }) {
  return (
    <Card
      title="取舍"
      description={`已安排 ${tradeoffs.totalPlannedMinutes} 分钟 · 三项配比之和按已安排分钟计`}
    >
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <div className="rounded-md border border-line px-2.5 py-2">
          <p className="text-[11px] text-inkMuted">P0 必须完成</p>
          <p className="text-ink">{pct(tradeoffs.p0Ratio)}</p>
        </div>
        <div className="rounded-md border border-line px-2.5 py-2">
          <p className="text-[11px] text-inkMuted">核心（P1 + P2）</p>
          <p className="text-ink">{pct(tradeoffs.coreRatio)}</p>
        </div>
        <div className="rounded-md border border-line px-2.5 py-2">
          <p className="text-[11px] text-inkMuted">拓展（P3）</p>
          <p className="text-ink">{pct(tradeoffs.extensiveRatio)}</p>
        </div>
      </div>

      <div className="mt-3">
        <p className="text-[11px] font-semibold text-ink">被预算挤掉（按候选预计分钟计，不是计划分钟）</p>
        {tradeoffs.excludedByBudget.length === 0 ? (
          <p className="mt-1 text-xs text-inkMuted">没有候选因预算被挤掉。</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {tradeoffs.excludedByBudget.map((row) => (
              <li key={`${row.title}:${row.reason}`} className="text-xs text-ink">
                {row.title}
                <span className="ml-1 text-inkMuted">
                  · 预计 {row.estMinutes} 分钟 · {row.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3">
        <p className="text-[11px] font-semibold text-ink">补测延后</p>
        {tradeoffs.uncertaintyDeferred.length === 0 ? (
          <p className="mt-1 text-xs text-inkMuted">没有延后的补测。</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {tradeoffs.uncertaintyDeferred.map((row) => (
              <li key={row.skill} className="text-xs text-ink">
                {row.skill}
                <span className="ml-1 text-inkMuted">· {row.why}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}