/**
 * 阶段门禁（H1–H5）副卡。
 *
 * 与五维 readiness 并列但**不是同一套判定**：门禁看验收项与复习/EGIU 指标，
 * readiness 看证据覆盖与迁移。两者都只展示，不在这里改结论。
 */

import type { GateResult } from '@/lib/types';

export function GateChecklistCard({ gate }: { gate: GateResult | null }) {
  if (!gate) {
    return (
      <p className="text-[11px] text-inkMuted">
        门禁数据不可用（阶段不存在或读取失败）。门禁不通过不会阻止你查看证据，但结论以 readiness 五维为准。
      </p>
    );
  }

  return (
    <div data-testid="gate-checklist" className="space-y-1.5 text-[11px]">
      <p className="text-ink">
        验收门禁：{gate.metrics.requiredPassed}/{gate.metrics.requiredTotal} 项必验通过 · H3 复习通过率{' '}
        {gate.metrics.h3Rate === null ? '—' : `${Math.round(gate.metrics.h3Rate * 100)}%`} · 红灯单元{' '}
        {gate.metrics.redLessons}
      </p>
      {gate.unmet.length > 0 ? (
        <ul className="space-y-0.5 text-amber-800">
          {gate.unmet.map((item) => (
            <li key={item.code}>
              {item.label}：当前 {item.current}，目标 {item.target}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-inkMuted">门禁没有未满足项。</p>
      )}
      {gate.suggested && (
        <p className="font-medium text-green-700">门禁建议：可以进入下一阶段评审（仍需你确认）。</p>
      )}
      <p className="text-inkMuted">
        说明：H4「投入稳定性」自 v2.7 起只作参考，不参与晋级判定。
      </p>
    </div>
  );
}