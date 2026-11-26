/**
 * `/planner/replan` 当日重排。
 *
 * `date` 缺省为今天；当日没有任务时直接给空态（重排无法凭空生成新计划）。
 */

import { businessToday } from '@/lib/businessTime';
import { getReplanContext } from '@/lib/queries/planner';
import { PlannerEmptyState } from '@/components/planner/shared/EmptyState';
import { ReplanPreviewBody } from '@/components/planner/replan/ReplanPreviewBody';

export const dynamic = 'force-dynamic';

export default async function PlannerReplanPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const planDate = params.date ?? (await businessToday());
  const context = await getReplanContext(planDate);

  if (!context.hasTasks) {
    return (
      <PlannerEmptyState
        title="当天还没有任务"
        description="重排只调整已有任务；当天没有计划时，请先生成一份计划。"
        dependencies={['一份已确认的当日计划']}
        primaryHref="/planner/build"
        primaryLabel="去计划构建"
      />
    );
  }

  return <ReplanPreviewBody context={context} />;
}