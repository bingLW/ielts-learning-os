/**
 * `/planner/build` 计划构建。
 *
 * `horizon` 只接受 1 / 7 / 30 / 90（与服务端 `HORIZON_DAYS` 同口径），非法值回落 7 天；
 * `draft` 指向一次 PlanningSnapshot 草稿锚点（不是 PlanVersion）。
 */

import { HORIZON_DAYS } from '@/lib/services/planBuild';
import { getBuilderContext, getDraft } from '@/lib/queries/planner';
import { PlanBuilderBody } from '@/components/planner/build/PlanBuilderBody';

export const dynamic = 'force-dynamic';

function parseHorizon(raw: string | undefined): number {
  const parsed = Number(raw);
  return (HORIZON_DAYS as readonly number[]).includes(parsed) ? parsed : 7;
}

export default async function PlannerBuildPage({
  searchParams,
}: {
  searchParams: Promise<{ horizon?: string; draft?: string }>;
}) {
  const params = await searchParams;
  const horizonDays = parseHorizon(params.horizon);

  const [context, draft] = await Promise.all([
    getBuilderContext(horizonDays),
    params.draft ? getDraft(params.draft) : Promise.resolve(null),
  ]);

  return <PlanBuilderBody context={context} horizonDays={horizonDays} draft={draft} />;
}