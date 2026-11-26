/**
 * 辅助维度折叠区。
 *
 * 折叠 + 显式标注「不计入四技能配比」，是因为辅助维度（如语法错点、词汇广度）
 * **不参与**听说读写四技能的配额分配；与官方维度平铺会让用户误以为它们同权。
 */

import { EVIDENCE_SKILL_LABEL_ZH } from '@/lib/constants';
import type { GapRowDto } from '@/lib/queries/planner';
import type { EvidenceSkill } from '@/lib/types';

export function AuxiliaryAccordion({ gaps }: { gaps: GapRowDto[] }) {
  return (
    <details className="rounded-md border border-line bg-surfaceAlt" open={false}>
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink">
        辅助维度（{gaps.length}）
      </summary>
      <div className="border-t border-line px-3 py-2">
        <p className="mb-1 text-[11px] font-medium text-inkMuted">辅助维度，不计入四技能配比</p>
        <p className="mb-1 text-[11px] text-inkMuted">
          辅助维度供参考，不参与听说读写四技能的预算与目标配比。
        </p>
        {gaps.length === 0 ? (
          <p className="text-xs text-inkMuted">本快照没有辅助维度记录。</p>
        ) : (
          <ul className="divide-y divide-line">
            {gaps.map((gap) => (
              <li key={gap.id} className="py-1.5 text-xs">
                <span className="mr-2 text-ink">
                  {EVIDENCE_SKILL_LABEL_ZH[gap.skill as EvidenceSkill] ?? gap.skill}
                  {gap.subskill ? ` · ${gap.subskill}` : ''}
                </span>
                <span className="text-[11px] text-inkMuted">
                  {gap.kind} · 严重度 {gap.severity.toFixed(2)} · 证据 {gap.evidenceCount} 条
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}