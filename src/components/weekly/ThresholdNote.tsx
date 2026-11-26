/**
 * 计划变更阈值说明（PRD §4.8⑥）。
 *
 * 无论是否建议改计划，这一段都必须展示 —— 用户要能看到「这周为什么没改计划」，
 * 否则「系统什么也没说」会被误读成「系统什么也没看」。
 */

import type { WeeklyDeltaResult } from '@/lib/domain/weeklyDelta';

export function ThresholdNote({ delta }: { delta: WeeklyDeltaResult }) {
  return (
    <div
      data-testid="weekly-threshold-note"
      className={[
        'rounded-md border px-2.5 py-1.5 text-[11px]',
        delta.changeRecommended
          ? 'border-green-300 bg-green-50 text-green-900'
          : 'border-line bg-surfaceAlt text-inkMuted',
      ].join(' ')}
    >
      <p className="font-medium">
        {delta.changeRecommended ? '已达到改计划阈值' : '未达改计划阈值，计划不变更'}
      </p>
      <p data-testid="threshold-note-text" className="mt-0.5">
        {delta.thresholdNote}
      </p>
    </div>
  );
}