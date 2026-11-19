/**
 * 指标磁贴。
 *
 * 四类量（计划时长 / 实际时长 / 有效产出 / 知识掌握）刻意用四种不同 `tone`，
 * 且都带单位与说明 —— 防止把「时长」误读成「能力」。
 */

import type { ReactNode } from 'react';

export type StatTone = 'neutral' | 'plan' | 'actual' | 'output' | 'mastery' | 'warn';

const TONE_CLASS: Record<StatTone, string> = {
  neutral: 'bg-surfaceAlt border-line',
  plan: 'bg-blue-50 border-blue-200',
  actual: 'bg-emerald-50 border-emerald-200',
  output: 'bg-amber-50 border-amber-200',
  mastery: 'bg-violet-50 border-violet-200',
  warn: 'bg-red-50 border-red-200',
};

export interface StatTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: StatTone;
  /** 说明这一类量的口径，避免概念混用。 */
  scopeNote?: string;
}

export function StatTile({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
  scopeNote,
}: StatTileProps) {
  return (
    <div className={['rounded-md border p-3', TONE_CLASS[tone]].join(' ')}>
      <div className="text-xs font-medium text-inkMuted">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="tabular text-xl font-semibold text-ink">{value}</span>
        {unit && <span className="text-xs text-inkMuted">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-xs text-inkMuted">{hint}</div>}
      {scopeNote && <div className="mt-1 text-[11px] text-inkMuted">口径：{scopeNote}</div>}
    </div>
  );
}
