/**
 * `/planner/evidence`：四技能 Tab + 缺口/不确定两段 + 辅助维度折叠。
 *
 * Tab 用 `<a href>` 而不是客户端状态：每个 Tab 都是可分享、可回退的地址
 * （`?snapshot=&skill=`），刷新之后仍停在同一技能上。
 */

import { Card } from '@/components/ui/Card';
import { EVIDENCE_SKILL_LABEL_ZH } from '@/lib/constants';
import type { GapSummaryDto } from '@/lib/queries/planner';
import type { EvidenceDetailDto, EvidenceSkill } from '@/lib/types';
import { EvidenceDrawer } from '../shared/EvidenceDrawer';
import { AuxiliaryAccordion } from './AuxiliaryAccordion';
import { FreshnessBar } from './FreshnessBar';
import { GapList } from './GapList';
import { UncertaintyList } from './UncertaintyList';

type OfficialSkill = keyof GapSummaryDto['official'];

const SKILL_ORDER: OfficialSkill[] = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'];

function tabHref(snapshotId: string, skill: OfficialSkill): string {
  return `/planner/evidence?snapshot=${snapshotId}&skill=${skill}`;
}

export function GapSummaryBody({
  summary,
  activeSkill,
  evidenceId,
  evidence,
}: {
  summary: GapSummaryDto;
  activeSkill: OfficialSkill;
  evidenceId: string | null;
  evidence: EvidenceDetailDto | null;
}) {
  const confirmed = summary.official[activeSkill]?.filter((gap) => gap.kind === 'GAP') ?? [];
  const uncertainties = summary.official[activeSkill]?.filter((gap) => gap.kind !== 'GAP') ?? [];
  const noBaseline = confirmed.length === 0 && uncertainties.length === 0;

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-base font-semibold text-ink">依据与缺口</h1>
        <p className="text-xs text-inkMuted">
          排课只认证据。缺口来自快照中的 OFFICIAL 维度；辅助维度单列，不计入四技能配比。
        </p>
      </div>

      <FreshnessBar summary={summary} />

      {evidenceId && (
        <EvidenceDrawer evidenceId={evidenceId} evidence={evidence} closeHref={tabHref(summary.snapshot.id, activeSkill)} />
      )}

      <div role="tablist" aria-label="四技能" className="flex flex-wrap gap-1">
        {SKILL_ORDER.map((skill) => {
          const active = skill === activeSkill;
          return (
            <a
              key={skill}
              role="tab"
              aria-selected={active}
              href={tabHref(summary.snapshot.id, skill)}
              className={[
                'rounded-md border px-2.5 py-1 text-xs',
                active ? 'border-brand bg-blue-50 font-medium text-brand' : 'border-line text-ink hover:bg-surfaceAlt',
              ].join(' ')}
            >
              {EVIDENCE_SKILL_LABEL_ZH[skill]}
            </a>
          );
        })}
      </div>

      <div role="tabpanel" data-skill={activeSkill} className="space-y-3">
        {noBaseline ? (
          <Card title={`${EVIDENCE_SKILL_LABEL_ZH[activeSkill]}：无基线`}>
            <p className="text-xs text-ink">
              该技能还没有可用的证据基线：系统不假定 0 分，也不把它记成「满分」。
            </p>
            <p className="mt-1 text-[11px] text-inkMuted">
              正确动作是先做一次补测（PROBE），拿到基线之后再谈缺口。
            </p>
            <a
              href={`/planner/candidates?snapshot=${summary.snapshot.id}&skill=${activeSkill}&sourceKind=PROBE`}
              className="mt-2 inline-block text-xs text-brand"
            >
              一键排基线任务 →
            </a>
          </Card>
        ) : (
          <>
            <Card
              title={`${EVIDENCE_SKILL_LABEL_ZH[activeSkill]}：已证实缺口（${confirmed.length}）`}
              description="证据指向的偏离；严重度 = 证据支持下的偏离幅度"
            >
              <GapList gaps={confirmed} snapshotId={summary.snapshot.id} />
            </Card>
            <Card
              title={`${EVIDENCE_SKILL_LABEL_ZH[activeSkill]}：证据不足（${uncertainties.length}）`}
              description="没练够 ≠ 弱项；先补测再判断"
            >
              <UncertaintyList gaps={uncertainties} snapshotId={summary.snapshot.id} skill={activeSkill} />
            </Card>
          </>
        )}
      </div>

      <AuxiliaryAccordion gaps={summary.auxiliary} />
    </div>
  );
}