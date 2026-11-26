/**
 * 状态带：一屏回答「我在哪 / 今天多少时间 / 这周缺口多大 / AI 参没参与」。
 * 分钟一律带口径前缀（计划 / 实际净），两套口径不互推。
 */

import { Card } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { AI_MODE_LABEL_ZH } from '@/lib/constants';
import type { PlannerDashboardDto } from '@/lib/queries/planner';
import { MinutesWithProvenance } from '../shared/MinutesWithProvenance';

const AI_BADGE_CLASS: Record<'off' | 'on' | 'failed', string> = {
  off: 'border-line bg-surfaceAlt text-inkMuted',
  on: 'border-violet-300 bg-violet-50 text-violet-700',
  failed: 'border-amber-300 bg-amber-50 text-amber-800',
};

export function StatusBand({
  statusBand,
  weeklyGap,
}: Pick<PlannerDashboardDto, 'statusBand' | 'weeklyGap'>) {
  return (
    <Card
      title="状态带"
      description={
        statusBand.stageName
          ? `当前阶段：${statusBand.stageName}（${statusBand.stageCode ?? '-'}）`
          : '尚未激活学习阶段'
      }
      actions={
        <span
          title={`aiMode=${statusBand.aiMode}`}
          className={[
            'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            AI_BADGE_CLASS[statusBand.aiMode],
          ].join(' ')}
        >
          {AI_MODE_LABEL_ZH[statusBand.aiMode]}
        </span>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          tone="plan"
          label="今日预算"
          value={statusBand.isRestDay ? '休息日' : statusBand.budgetMinutes}
          unit={statusBand.isRestDay ? undefined : '分钟'}
          scopeNote={statusBand.isSuggestion ? '仍是初始建议值，不是你填的真实可用时间' : '来自你的每日预算设置'}
        />
        <StatTile
          tone="plan"
          label="今日已排"
          value={<MinutesWithProvenance kind="PLAN" minutes={statusBand.plannedMinutes} />}
          hint={`${statusBand.doneCount}/${statusBand.taskCount} 项已完成`}
        />
        <StatTile
          tone="actual"
          label="今日实际净"
          value={<MinutesWithProvenance kind="ACTUAL_NET" minutes={statusBand.actualNetMinutes} />}
        />
        <StatTile
          tone="neutral"
          label="本周（单调口径）"
          value={weeklyGap.targetMinutes === null ? '未设周目标' : weeklyGap.targetMinutes}
          unit={weeklyGap.targetMinutes === null ? undefined : '分钟'}
          hint={
            <span>
              计划 {weeklyGap.plannedMinutes} · 实际净 {weeklyGap.netMinutes} · 容量 {weeklyGap.capacityMinutes}
            </span>
          }
        />
      </div>
      <p className="mt-2 text-[11px] text-inkMuted">
        {statusBand.aiNote} · 本周区间 {weeklyGap.weekStart} ~ {weeklyGap.weekEnd}
      </p>
    </Card>
  );
}