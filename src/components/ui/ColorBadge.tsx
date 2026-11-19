/**
 * 三色徽章。
 *
 * 色盲可达要求（PRD §8）：**必须**同时给出「图标 + 中文文字」，不允许只靠颜色。
 * 这里 GREEN 用对勾、YELLOW 用感叹号、RED 用警报、PENDING 用空心圆。
 */

import { EGIU_COLOR_LABEL_ZH } from '@/lib/constants';
import type { EgiuColor } from '@/lib/types';
import { Icon, type IconName } from './Icon';

const COLOR_STYLE: Record<EgiuColor, { wrap: string; icon: IconName }> = {
  GREEN: { wrap: 'border-emerald-300 bg-emerald-50 text-emerald-800', icon: 'check' },
  YELLOW: { wrap: 'border-amber-300 bg-amber-50 text-amber-800', icon: 'alert' },
  RED: { wrap: 'border-red-300 bg-red-50 text-red-800', icon: 'alert' },
  PENDING: { wrap: 'border-slate-300 bg-slate-50 text-slate-600', icon: 'circle' },
};

export interface ColorBadgeProps {
  color: EgiuColor;
  /** 降权档的综合分，展示为 `S=0.775`。 */
  score?: number | null;
  showLabel?: boolean;
}

export function ColorBadge({ color, score, showLabel = true }: ColorBadgeProps) {
  const style = COLOR_STYLE[color];
  return (
    <span
      title={`${color}${typeof score === 'number' ? ` · S=${score}` : ''}`}
      className={[
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        style.wrap,
      ].join(' ')}
    >
      <Icon name={style.icon} size={12} />
      {showLabel && EGIU_COLOR_LABEL_ZH[color]}
      {typeof score === 'number' && (
        <span className="tabular opacity-80">S={Number(score.toFixed(3))}</span>
      )}
    </span>
  );
}

/** 三色图例（色盲可达：图标 + 文字 + 计数）。 */
export function ColorLegend({
  counts,
}: {
  counts: Record<EgiuColor, number>;
}) {
  const order: EgiuColor[] = ['GREEN', 'YELLOW', 'RED', 'PENDING'];
  return (
    <ul className="flex flex-wrap items-center gap-1.5">
      {order.map((color) => (
        <li key={color}>
          <span
            className={[
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
              COLOR_STYLE[color].wrap,
            ].join(' ')}
          >
            <Icon name={COLOR_STYLE[color].icon} size={11} />
            {EGIU_COLOR_LABEL_ZH[color]}
            <b className="tabular">{counts[color]}</b>
          </span>
        </li>
      ))}
    </ul>
  );
}
