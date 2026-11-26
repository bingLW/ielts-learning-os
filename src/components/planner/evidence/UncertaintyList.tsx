/**
 * 证据不足（待补测）列表。
 *
 * 与「已证实缺口」分开渲染：这里每一条的含义是「**没测够**」，
 * 正确动作是排一条 PROBE 任务去测，而不是把它当弱项刷题。
 */

import { EVIDENCE_SKILL_LABEL_ZH, GAP_KIND_LABEL_ZH } from '@/lib/constants';
import type { GapRowDto } from '@/lib/queries/planner';
import type { EvidenceSkill } from '@/lib/types';

export function UncertaintyList({
  gaps,
  snapshotId,
  skill,
}: {
  gaps: GapRowDto[];
  snapshotId: string;
  skill: string;
}) {
  if (gaps.length === 0) {
    return <p className="px-1 py-2 text-xs text-inkMuted">该技能没有不确定项。</p>;
  }
  return (
    <ul className="divide-y divide-line rounded-md border border-dashed border-line">
      {gaps.map((gap) => (
        <li key={gap.id} className="px-2.5 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">
              {EVIDENCE_SKILL_LABEL_ZH[gap.skill as EvidenceSkill] ?? gap.skill}
              {gap.subskill ? ` · ${gap.subskill}` : ''}
            </span>
            <span className="rounded bg-amber-50 px-1 text-[11px] text-amber-800">
              {GAP_KIND_LABEL_ZH[gap.kind] ?? gap.kind}
            </span>
            <span className="text-[11px] text-inkMuted">证据 {gap.evidenceCount} 条</span>
            {gap.coverageRatio !== null && (
              <span className="text-[11px] text-inkMuted">
                覆盖 {Math.round(gap.coverageRatio * 100)}%
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-inkMuted">{gap.reason}</p>
          {gap.missingEvidence.length > 0 && (
            <p className="mt-0.5 text-[11px] text-inkMuted">
              待补测：{gap.missingEvidence.join('、')}
            </p>
          )}
          <a href={`/planner/candidates?snapshot=${snapshotId}&skill=${skill}&sourceKind=PROBE`} className="mt-0.5 inline-block text-[11px] text-brand">
            去排一条补测任务 →
          </a>
        </li>
      ))}
    </ul>
  );
}