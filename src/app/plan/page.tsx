/**
 * `/plan` 学习计划页（列表视图）。
 *
 * 服务端职责：确定业务日期、读库、算聚合；交互全部下沉到客户端组件。
 */

import { businessToday } from '@/lib/businessTime';
import { isValidDateString } from '@/lib/date';
import { getPlanPage, getWeekStrip } from '@/lib/queries/plan';
import { PlanPageBody } from '@/components/plan/PlanPageBody';

export const dynamic = 'force-dynamic';

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const todayStr = await businessToday();
  const planDate = isValidDateString(params.date) ? params.date : todayStr;

  const [data, weekStrip] = await Promise.all([getPlanPage(planDate), getWeekStrip(planDate)]);

  return <PlanPageBody data={data} todayStr={todayStr} weekStrip={weekStrip} />;
}
