/**
 * Dashboard ④ 本周卡：净时长、完成率、与上周 ↑↓ 绝对差。
 */

import { formatDurationZh, formatMinutesDelta, formatPercent } from '@/lib/format';
import type { DashboardDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';

export function WeekCard({ data }: { data: DashboardDto['week'] }) {
  const up = data.netDelta > 0;
  const flat = data.netDelta === 0;

  return (
    <Card title="本周" description={`${data.weekStart} ~ ${data.weekEnd}（ISO 周，周一起）`}>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2">
          <p className="text-[11px] text-inkMuted">净学习时长</p>
          <p className="tabular text-lg font-semibold text-ink">
            {formatDurationZh(data.netMinutes)}
          </p>
          <p
            className={[
              'tabular text-[11px]',
              flat ? 'text-inkMuted' : up ? 'text-emerald-700' : 'text-red-700',
            ].join(' ')}
          >
            {formatMinutesDelta(data.netDelta)}
          </p>
        </div>
        <div className="rounded-md border border-blue-200 bg-blue-50 p-2">
          <p className="text-[11px] text-inkMuted">完成率（按时长加权）</p>
          <p className="tabular text-lg font-semibold text-ink">
            {formatPercent(data.completionByTime)}
          </p>
          <p className="text-[11px] text-inkMuted">先合并全周分子分母再相除</p>
        </div>
        <div className="rounded-md border border-line bg-surfaceAlt p-2">
          <p className="text-[11px] text-inkMuted">上周净时长</p>
          <p className="tabular text-lg font-semibold text-ink">
            {formatDurationZh(data.prevNetMinutes)}
          </p>
          <p className="text-[11px] text-inkMuted">对照基准</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-inkMuted">
        护栏要求：净时长必须与计划完成率成对解读，单独任一项都不能代表能力提升。
      </p>
    </Card>
  );
}
