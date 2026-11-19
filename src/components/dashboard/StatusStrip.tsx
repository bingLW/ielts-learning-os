/**
 * Dashboard ① 状态条：阶段名 + 开始日期 + 已进行天数 + 距预估上限剩余天数。
 */

import { formatBand } from '@/lib/format';
import type { StatusStripDto } from '@/lib/types';
import { StatTile } from '@/components/ui/StatTile';

export function StatusStrip({ strip }: { strip: StatusStripDto | null }) {
  if (!strip) {
    return (
      <StatTile
        label="当前阶段"
        value="未开始"
        hint="请先到「阶段与验收」激活阶段"
        tone="neutral"
      />
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        label="当前阶段"
        value={strip.stageName}
        hint={strip.startedAt ? `开始于 ${strip.startedAt}` : '尚未设置开始日期'}
        tone="neutral"
      />
      <StatTile
        label="已进行天数"
        value={strip.elapsedDays}
        unit="天"
        hint={`预估 ${strip.estDaysMin}${strip.estDaysMax ? `–${strip.estDaysMax}` : ' 或更久'} 天`}
        tone="plan"
      />
      <StatTile
        label={strip.overrunDays > 0 ? '已超预估区间' : '距预估上限'}
        value={
          strip.overrunDays > 0
            ? strip.overrunDays
            : strip.remainDays !== null
              ? strip.remainDays
              : '—'
        }
        unit="天"
        hint={
          strip.overrunDays > 0
            ? '超出预估不判定失败，决策权在用户'
            : '超出后仅提示，不自动升级'
        }
        tone={strip.overrunDays > 0 ? 'warn' : 'actual'}
      />
      <StatTile
        label="目标 Band"
        value={formatBand(strip.targetBand)}
        hint="个人目标分，非官方成绩"
        tone="mastery"
      />
    </div>
  );
}
