/**
 * `/planner/explain/[versionId]` 解释与取舍。
 *
 * `?evidence=<id>` 只展开只读证据抽屉，不换页、不改版本。
 */

import { notFound } from 'next/navigation';
import { getEvidenceDetail } from '@/lib/queries/evidence';
import { getPlanExplanation } from '@/lib/queries/planner';
import { ExplanationBody } from '@/components/planner/explain/ExplanationBody';

export const dynamic = 'force-dynamic';

export default async function PlannerExplainPage({
  params,
  searchParams,
}: {
  params: Promise<{ versionId: string }>;
  searchParams: Promise<{ evidence?: string }>;
}) {
  const { versionId } = await params;
  const { evidence: evidenceParam } = await searchParams;

  const data = await getPlanExplanation(versionId);
  if (!data) notFound();

  const evidenceId = evidenceParam ?? null;
  const evidence = evidenceId ? await getEvidenceDetail(evidenceId) : null;

  return <ExplanationBody data={data} evidenceId={evidenceId} evidence={evidence} />;
}