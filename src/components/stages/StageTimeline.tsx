/**
 * 阶段时间线。
 *
 * 文案约束：阶段名固定带「训练区间」，且页面必须并置 CEFR 免责声明。
 */

import { STAGE_STATUS_LABEL_ZH } from '@/lib/constants';
import { formatDurationZh } from '@/lib/format';
import type { StageTimelineItemDto } from '@/lib/types';
import { StatusBadge } from '@/components/ui/StatusBadge';

export function StageTimeline({ stages }: { stages: StageTimelineItemDto[] }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {stages.map((stage) => {
        const overrun =
          stage.estDaysMax !== null && stage.elapsedDays > stage.estDaysMax && stage.isActive;
        return (
          <li
            key={stage.id}
            className={[
              'rounded-lg border p-3',
              stage.isActive ? 'border-brand bg-blue-50/40' : 'border-line bg-surface',
            ].join(' ')}
          >
            <div className="flex items-start justify-between gap-1">
              <h3 className="text-xs font-semibold leading-snug text-ink">{stage.nameZh}</h3>
              <StatusBadge status={stage.status} />
            </div>

            <p className="mt-1 text-[11px] text-inkMuted">
              预计 {stage.estDaysMin}
              {stage.estDaysMax ? `–${stage.estDaysMax}` : ' 或更久'} 天 · 验收{' '}
              <b className="tabular text-ink">{stage.passedCount}</b>/{stage.requiredTotal} 必验项
            </p>

            <p className="tabular mt-1 text-[11px] text-inkMuted">
              {stage.startedAt ? `开始 ${stage.startedAt}` : '尚未开始'}
              {stage.completedAt ? ` · 结束 ${stage.completedAt}` : ''}
            </p>

            {stage.startedAt && (
              <p className="tabular text-[11px] text-inkMuted">
                已进行 {stage.elapsedDays} 天
                {overrun && (
                  <span className="ml-1 text-amber-800">
                    · 已超预估区间 {stage.elapsedDays - (stage.estDaysMax ?? 0)} 天（不判失败）
                  </span>
                )}
              </p>
            )}

            {stage.estDaysMax && stage.isActive && stage.elapsedDays <= stage.estDaysMax && (
              <p className="text-[11px] text-inkMuted">
                距预估上限还有 {stage.estDaysMax - stage.elapsedDays} 天（
                {formatDurationZh((stage.estDaysMax - stage.elapsedDays) * 60)}）
              </p>
            )}

            <p className="mt-1 text-[10px] text-inkMuted">
              {STAGE_STATUS_LABEL_ZH[stage.status]} · 阶段对应关系为规划，非官方认证
            </p>
          </li>
        );
      })}
    </ol>
  );
}
