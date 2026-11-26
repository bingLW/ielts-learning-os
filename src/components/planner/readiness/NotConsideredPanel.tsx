/**
 * 「不参与判定」反例区（PRD §4.9③）。
 *
 * 明确列出学习天数 / 完成率 / 单次 AI 分数**当前有多好看**，同时写明它们不参与判定 ——
 * 让用户看到「好看但不作数」，避免把时长当能力。
 */

import type { ReadinessViewDto } from '@/lib/queries/planner';

export function NotConsideredPanel({ rows }: { rows: ReadinessViewDto['notConsidered'] }) {
  return (
    <div data-testid="not-considered" className="rounded border border-line bg-surfaceAlt px-2.5 py-1.5">
      <p className="text-[11px] font-medium text-ink">明确排除：以下指标不参与判定</p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((row) => (
          <li key={row.label} className="text-[11px] text-inkMuted">
            <span className="text-ink">{row.label}：</span>
            <span className="tabular">{row.value}</span>
            <span className="ml-1">（{row.note}）</span>
          </li>
        ))}
      </ul>
    </div>
  );
}