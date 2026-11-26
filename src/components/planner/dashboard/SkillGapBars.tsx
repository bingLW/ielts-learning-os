/**
 * 四技能缺口条：只用 `dimensionKind='OFFICIAL'` 的缺口（辅助维度不进这里）。
 * 长度为 `severity`（0..1），不是「错误率」，标签写「缺口严重度」以免误读。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { EVIDENCE_SKILL_LABEL_ZH } from '@/lib/constants';
import type { GapRowDto } from '@/lib/queries/planner';
import type { EvidenceSkill } from '@/lib/types';

export function SkillGapBars({ gaps, snapshotId }: { gaps: GapRowDto[]; snapshotId: string | null }) {
  return (
    <Card
      title="计划缺口（四技能）"
      description="严重度 = 证据支持下的偏离幅度；辅助维度不计入四技能"
      actions={
        snapshotId ? (
          <Link href={`/planner/evidence?snapshot=${snapshotId}`} className="text-xs text-brand">
            查看依据 →
          </Link>
        ) : undefined
      }
    >
      {gaps.length === 0 ? (
        <p className="text-xs text-inkMuted">四技能暂无可证实缺口（不代表没有弱项，只代表证据还没指向它）。</p>
      ) : (
        <ul className="space-y-2">
          {gaps.map((gap) => (
            <li key={gap.id}>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-ink">
                  {EVIDENCE_SKILL_LABEL_ZH[gap.skill as EvidenceSkill] ?? gap.skill}
                  {gap.subskill ? ` · ${gap.subskill}` : ''}
                </span>
                <span className="tabular text-inkMuted">缺口严重度 {gap.severity.toFixed(2)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surfaceAlt">
                <div
                  className="h-full rounded-full bg-amber-500"
                  style={{ width: `${Math.min(100, Math.max(0, gap.severity * 100))}%` }}
                />
              </div>
              <p className="mt-0.5 text-[11px] text-inkMuted">
                {gap.reason} · 证据 {gap.evidenceCount} 条（独立 {gap.independentCount}）·
                {gap.freshnessDays === null ? ' 无新鲜度数据' : ` 最近 ${gap.freshnessDays} 天前`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}