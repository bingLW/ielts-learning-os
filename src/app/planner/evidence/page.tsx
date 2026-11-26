/**
 * `/planner/evidence` 依据与缺口。
 *
 * 三个查询参数：
 * - `snapshot`：看哪一次快照（缺省 = 最近一次）；
 * - `skill`：当前 Tab（缺省 LISTENING）；
 * - `evidence`：展开哪条证据的只读详情。
 */

import { getEvidenceDetail } from '@/lib/queries/evidence';
import { getGapSummary } from '@/lib/queries/planner';
import { GapSummaryBody } from '@/components/planner/evidence/GapSummaryBody';
import { PlannerEmptyState } from '@/components/planner/shared/EmptyState';
import type { GapSummaryDto } from '@/lib/queries/planner';

export const dynamic = 'force-dynamic';

type OfficialSkill = keyof GapSummaryDto['official'];

const OFFICIAL_SKILLS: OfficialSkill[] = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'];

function asSkill(value: string | undefined): OfficialSkill {
  return OFFICIAL_SKILLS.includes(value as OfficialSkill) ? (value as OfficialSkill) : 'LISTENING';
}

export default async function PlannerEvidencePage({
  searchParams,
}: {
  searchParams: Promise<{ snapshot?: string; skill?: string; evidence?: string }>;
}) {
  const params = await searchParams;
  const summary = await getGapSummary(params.snapshot ?? null);

  if (!summary) {
    return (
      <PlannerEmptyState
        title="还没有规划快照"
        description="缺口与依据都来自一次「计划生成」的快照。先构建一次，再回来看这里。"
        dependencies={['至少 1 条学习证据', '一次计划生成产生的 PlanningSnapshot']}
        primaryHref="/planner/build"
        primaryLabel="去计划构建"
      />
    );
  }

  const evidenceId = params.evidence ?? null;
  const evidence = evidenceId ? await getEvidenceDetail(evidenceId) : null;

  return (
    <GapSummaryBody
      summary={summary}
      activeSkill={asSkill(params.skill)}
      evidenceId={evidenceId}
      evidence={evidence}
    />
  );
}