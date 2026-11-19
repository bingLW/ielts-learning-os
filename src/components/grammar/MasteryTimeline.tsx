/**
 * 掌握度变化时间线（T23）。
 *
 * 只展示「颜色发生迁移」的节点 —— 连续同色复测不重复刷屏，
 * 但原始复测记录仍在下方历史表里一条不少。
 */

import { EGIU_COLOR_LABEL_ZH } from '@/lib/constants';
import type { EgiuMasteryChangeDto } from '@/lib/types';
import { ColorBadge } from '@/components/ui/ColorBadge';

export function MasteryTimeline({ changes }: { changes: EgiuMasteryChangeDto[] }) {
  if (changes.length === 0) {
    return (
      <p className="py-3 text-center text-xs text-inkMuted">
        还没有复测记录，暂无颜色迁移。录入首测（D0）后会在这里出现第一个节点。
      </p>
    );
  }

  return (
    <ol className="relative space-y-2 border-l border-line pl-3">
      {changes.map((change, index) => (
        <li key={`${change.changedAt}-${index}`} className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[15px] top-1.5 h-2 w-2 rounded-full bg-brand"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="tabular text-[11px] text-inkMuted">{change.changedAt}</span>
            <span className="text-[11px] font-medium text-ink">{change.label}</span>
            {change.fromColor && (
              <>
                <ColorBadge color={change.fromColor} showLabel />
                <span className="text-[11px] text-inkMuted">→</span>
              </>
            )}
            <ColorBadge color={change.toColor} showLabel />
          </div>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            {change.fromColor
              ? `${EGIU_COLOR_LABEL_ZH[change.fromColor]} → ${EGIU_COLOR_LABEL_ZH[change.toColor]}`
              : change.note}
          </p>
        </li>
      ))}
    </ol>
  );
}
