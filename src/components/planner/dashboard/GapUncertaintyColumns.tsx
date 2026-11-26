/**
 * 两列对照：**已证实缺口** vs **证据不足（待补测）**。
 * 二者合渲染会诱导用户把「没测过」当成「弱项」—— 这是 v2.7 最忌讳的误读。
 */

import { Card } from '@/components/ui/Card';
import { GAP_KIND_LABEL_ZH, EVIDENCE_SKILL_LABEL_ZH } from '@/lib/constants';
import type { GapRowDto } from '@/lib/queries/planner';
import type { EvidenceSkill } from '@/lib/types';

function Column({
  title,
  hint,
  rows,
}: {
  title: string;
  hint: string;
  rows: GapRowDto[];
}) {
  return (
    <div className="rounded-md border border-line">
      <div className="border-b border-line bg-surfaceAlt px-2.5 py-1.5">
        <p className="text-xs font-semibold text-ink">{title}</p>
        <p className="text-[11px] text-inkMuted">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-inkMuted">暂无</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.id} className="px-2.5 py-1.5 text-xs">
              <span className="mr-1 text-ink">
                {EVIDENCE_SKILL_LABEL_ZH[row.skill as EvidenceSkill] ?? row.skill}
              </span>
              <span className="text-[11px] text-inkMuted">
                {GAP_KIND_LABEL_ZH[row.kind] ?? row.kind} · 证据 {row.evidenceCount} 条
              </span>
              <p className="truncate text-[11px] text-inkMuted">{row.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GapUncertaintyColumns({ gaps, uncertainties }: { gaps: GapRowDto[]; uncertainties: GapRowDto[] }) {
  return (
    <Card title="缺口与不确定度" description="左边是「已证实」；右边是「证据不够，先补测」——不是弱项">
      <div className="grid gap-2 md:grid-cols-2">
        <Column title="已证实缺口" hint="证据支持下的偏离" rows={gaps} />
        <Column title="证据不足（待补测）" hint="系统不假定 0 分，排补测而不是下结论" rows={uncertainties} />
      </div>
    </Card>
  );
}