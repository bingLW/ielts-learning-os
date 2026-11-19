/**
 * Dashboard ② 四类量分区卡（不可混排）。
 *
 * 计划时长 / 实际净时长 / 有效产出 / 知识掌握 —— 四种量各有独立色系与口径说明，
 * 这是产品反「用高时长制造进步感」的核心结构。
 */

import { formatDurationZh, formatPercent } from '@/lib/format';
import type { DashboardZoneDto } from '@/lib/types';
import { StatTile } from '@/components/ui/StatTile';

export function QuantityZones({
  today,
  week,
}: {
  today: DashboardZoneDto;
  week: DashboardZoneDto;
}) {
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="今日 · 计划时长"
          value={formatDurationZh(today.plannedMinutes)}
          tone="plan"
          scopeNote="任务 planned_minutes 之和"
        />
        <StatTile
          label="今日 · 实际净时长"
          value={formatDurationZh(today.netMinutes)}
          tone="actual"
          scopeNote="计时段跨零点拆分求和，剔除中断与误触"
        />
        <StatTile
          label="今日 · 有效产出"
          value={today.effectiveOutputs}
          unit="条"
          tone="output"
          scopeNote="有正确率/≥20 字产出/录音链接/关联错题/英文摘要"
        />
        <StatTile
          label="知识掌握度"
          value={formatPercent(today.greenRatio)}
          tone="mastery"
          hint="EGIU 已绿灯单元占比（按最新判定去重）"
          scopeNote="每个单元只计最新一次判定"
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="本周 · 计划时长"
          value={formatDurationZh(week.plannedMinutes)}
          tone="plan"
        />
        <StatTile
          label="本周 · 实际净时长"
          value={formatDurationZh(week.netMinutes)}
          tone="actual"
        />
        <StatTile label="本周 · 有效产出" value={week.effectiveOutputs} unit="条" tone="output" />
        <StatTile
          label="本周 · 知识掌握度"
          value={formatPercent(week.greenRatio)}
          tone="mastery"
        />
      </div>
    </div>
  );
}
