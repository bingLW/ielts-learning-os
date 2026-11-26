/**
 * 今日决策卡：今天排了什么、P0/P1 各几条、完成到什么程度。
 * 只展示 `PlanTask.plannedMinutes` 与 `actualMinutes`，不掺候选预计分钟。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { TASK_PRIORITY_LABEL_ZH } from '@/lib/constants';
import type { PlannerDashboardDto } from '@/lib/queries/planner';
import { MinutesWithProvenance } from '../shared/MinutesWithProvenance';

export function TodayDecisionCard({ todayDecision }: Pick<PlannerDashboardDto, 'todayDecision'>) {
  return (
    <Card
      title="今日决策"
      description="优先级由规则评分决定；AI 只能润色措辞，不能改排序"
      actions={<Link href="/plan" className="text-xs text-brand">查看今天计划 →</Link>}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <StatTile
          tone="plan"
          label="计划分钟"
          value={<MinutesWithProvenance kind="PLAN" minutes={todayDecision.plannedMinutes} />}
        />
        <StatTile
          tone="actual"
          label="已完成"
          value={<MinutesWithProvenance kind="ACTUAL_NET" minutes={todayDecision.doneMinutes} />}
          hint={`共 ${todayDecision.taskCount} 项任务`}
        />
        <StatTile
          tone="warn"
          label="到期压力"
          value={`${todayDecision.p0Count} / ${todayDecision.p1Count}`}
          hint="P0 到期复习 / P1 阶段核心"
        />
      </div>

      {todayDecision.top.length === 0 ? (
        <p className="mt-2 text-xs text-inkMuted">今天还没有已排任务：去计划构建生成一版。</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {todayDecision.top.map((task) => (
            <li key={task.taskId} className="flex items-center justify-between gap-2 py-1.5 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span title={task.priority} className="shrink-0 text-[11px] text-inkMuted">
                  {TASK_PRIORITY_LABEL_ZH[task.priority] ?? task.priority}
                </span>
                <span className="truncate text-ink">{task.moduleLabel}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <MinutesWithProvenance kind="PLAN" minutes={task.plannedMinutes} />
                <StatusBadge status={task.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}