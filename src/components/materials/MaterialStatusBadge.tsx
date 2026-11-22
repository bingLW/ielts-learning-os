/**
 * 材料状态徽章。
 *
 * 颜色口径（PRD §8 + A-05）：ready→绿、partial→黄、failed→红、cancelled→灰、
 * 处理中→品牌蓝、待审核→紫。**颜色不是唯一载体**：每个徽章都带中文文案与原始英文
 * `title`，色盲用户与排查时都能读懂。
 */

import type { MaterialStatus } from '@/lib/constants';
import { MATERIAL_STATUS_LABELS_ZH } from '@/lib/constants';

const TONE_CLASS: Record<string, string> = {
  ready: 'border-egGreen/40 bg-egGreen/10 text-egGreen',
  partial: 'border-egYellow/50 bg-egYellow/10 text-egYellow',
  failed: 'border-egRed/40 bg-egRed/10 text-egRed',
  cancelled: 'border-line bg-surfaceAlt text-inkMuted',
  review_required: 'border-violet-300 bg-violet-50 text-violet-700',
  created: 'border-line bg-surfaceAlt text-inkMuted',
  validating: 'border-brand/40 bg-brand/10 text-brand',
  extracting: 'border-brand/40 bg-brand/10 text-brand',
  normalizing: 'border-brand/40 bg-brand/10 text-brand',
  analyzing: 'border-brand/40 bg-brand/10 text-brand',
  generating: 'border-brand/40 bg-brand/10 text-brand',
};

export function MaterialStatusBadge({
  status,
  className,
}: {
  status: MaterialStatus;
  className?: string;
}) {
  const tone = TONE_CLASS[status] ?? 'border-line bg-surfaceAlt text-inkMuted';
  return (
    <span
      title={status}
      className={[
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        tone,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {MATERIAL_STATUS_LABELS_ZH[status] ?? status}
    </span>
  );
}

/** 来源受限（unknown / licensed_subscription）的常驻警示（PRD A-05）。 */
export function RestrictedSourceWarning({ sourceTypeLabel }: { sourceTypeLabel: string }) {
  return (
    <span
      title={`来源：${sourceTypeLabel} —— 禁止导出与原文下载`}
      className="inline-flex items-center gap-1 rounded border border-egRed/40 bg-egRed/10 px-1.5 py-0.5 text-[11px] font-medium text-egRed"
    >
      <span aria-hidden="true">⚠</span>
      来源受限
    </span>
  );
}
