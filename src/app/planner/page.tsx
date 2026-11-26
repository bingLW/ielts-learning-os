/**
 * `/planner` 自适应计划首页（决策层）。
 *
 * 服务端只做一件事：按业务日期取齐仪表盘 DTO；渲染全部交给 `DashboardBody`。
 */

import { businessToday } from '@/lib/businessTime';
import { getPlannerDashboard } from '@/lib/queries/planner';
import { DashboardBody } from '@/components/planner/dashboard/DashboardBody';

export const dynamic = 'force-dynamic';

export default async function PlannerPage() {
  const data = await getPlannerDashboard(await businessToday());
  return <DashboardBody data={data} />;
}