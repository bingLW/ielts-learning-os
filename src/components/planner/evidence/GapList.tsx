/**
 * 已证实缺口列表（单技能一列）。
 *
 * 每条都带「证据 N 条 / 独立 K 条」两个数：证据条数不等于独立条数，
 * 五条同一次模考的错题只算一次独立表现 —— 这是缺口的置信度来源。
 */

import { EVIDENCE_SKILL_LABEL_ZH } from '@/lib/constants';
import type { GapRowDto } from '@/lib/queries/planner';
import type { EvidenceSkill } from '@/lib/types';
import { ConfidenceBadge } from '../shared/ConfidenceBadge';

function evidenceHref(snapshotId: string, skill: string, evidenceId: string): string {
  return `/planner/evidence?snapshot=${snapshotId}&skill=${skill}&evidence=${evidenceId}`;
}

export function GapList({
  gaps,
  snapshotId,
}: {
  gaps: GapRowDto[];
  snapshotId: string;
}) {
  if (gaps.length === 0) {
    return <p className="px-1 py-2 text-xs text-inkMuted">该技能没有已证实缺口。</p>;
  }
  return (
    <ul className="divide-y divide-line rounded-md border border-line">
      {gaps.map((gap) => (
        <li key={gap.id} className="px-2.5 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">
              {EVIDENCE_SKILL_LABEL_ZH[gap.skill as EvidenceSkill] ?? gap.skill}
              {gap.subskill ? ` · ${gap.subskill}` : ''}
            </span>
            <ConfidenceBadge confidence={gap.confidence} />
            <span className="tabular text-inkMuted">严重度 {gap.severity.toFixed(2)}</span>
            <span className="text-[11px] text-inkMuted">
              证据 {gap.evidenceCount} 条（独立 {gap.independentCount}）
            </span>
            {gap.freshnessDays !== null && (
              <span className="text-[11px] text-inkMuted">最近 {gap.freshnessDays} 天前</span>
            )}
            <span className="ml-auto text-[11px] text-inkMuted">state={gap.status}</span>
          </div>
          <p className="mt-1 text-[11px] text-inkMuted">{gap.reason}</p>
          {gap.missingEvidence.length > 0 && (
            <p className="mt-0.5 text-[11px] text-inkMuted">
              还缺的证据：{gap.missingEvidence.join('、')}
            </p>
          )}
          {gap.evidenceRefs.length > 0 && (
            <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
              <span className="text-inkMuted">证据：</span>
              {gap.evidenceRefs.map((ref) => (
                <a key={ref} href={evidenceHref(snapshotId, gap.skill, ref)} className="text-brand">
                  {ref.slice(0, 8)}
                </a>
              ))}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}