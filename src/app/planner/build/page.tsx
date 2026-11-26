/**
 * `/planner/build` 计划构建。
 *
 * `horizon` 只接受 1 / 7 / 30 / 90（与服务端 `HORIZON_DAYS` 同口径），非法值回落 7 天；
 * `draft` 指向一次 PlanningSnapshot 草稿锚点（不是 PlanVersion）。
 */

import { HORIZON_DAYS } from '@/lib/services/planBuild';
import { businessToday } from '@/lib/businessTime';
import { isValidDateString } from '@/lib/date';
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
  searchParams: Promise<{ horizon?: string; draft?: string; date?: string; budget?: string; proposal?: string }>;
}) {
  const params = await searchParams;
  const proposalId = params.proposal?.trim() || undefined;
  const horizonDays = proposalId ? 7 : parseHorizon(params.horizon);
  const asOfDate = params.date && isValidDateString(params.date) ? params.date : await businessToday();
  const parsedBudget = Number(params.budget);
  const budgetOverrideMinutes =
    params.budget !== undefined &&
    params.budget.trim() !== '' &&
    Number.isInteger(parsedBudget) &&
    parsedBudget >= 0 &&
    parsedBudget <= 600
      ? parsedBudget
      : undefined;

  const [context, draft] = await Promise.all([
    getBuilderContext(horizonDays, asOfDate),
    params.draft ? getDraft(params.draft) : Promise.resolve(null),
  ]);

  return (
    <PlanBuilderBody
      context={context}
      horizonDays={horizonDays}
      draft={draft}
      asOfDate={asOfDate}
      budgetOverrideMinutes={budgetOverrideMinutes}
      proposalId={proposalId}
    />
  );
}