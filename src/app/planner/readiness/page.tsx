/**
 * `/planner/readiness`（v2.7 T13）：用证据回答「我能不能宣布这个阶段结束」。
 *
 * 只读：结论取最近一次 `StageReadinessReview` 快照；评审生成与阶段切换都走
 * `actions/planner.ts`，页面不重算五维。
 */

import { businessToday } from '@/lib/businessTime';
import { getReadinessView } from '@/lib/queries/planner';
import { listStagesRaw } from '@/lib/queries/stages';
import { ReadinessBody } from '@/components/planner/readiness/ReadinessBody';
import { PlannerEmptyState } from '@/components/planner/shared/EmptyState';

export const dynamic = 'force-dynamic';

export default async function PlannerReadinessPage() {
  const asOfDate = await businessToday();
  const stages = await listStagesRaw();
  const active = stages.find((row) => row.status === 'ACTIVE') ?? stages[0] ?? null;

  if (!active) {
    return (
      <PlannerEmptyState
        title="还没有任何阶段"
        description="阶段是 readiness 的判定对象；先完成初始化（seed 会写入 4 个阶段），再回来评审。"
        dependencies={['阶段记录（/stages）']}
        primaryHref="/stages"
        primaryLabel="去阶段页"
      />
    );
  }

  const view = await getReadinessView(active.id);
  if (!view) {
    return (
      <PlannerEmptyState
        title="阶段数据读取失败"
        description="找不到当前阶段，无法展示五维证据。请刷新页面或检查数据库。"
        dependencies={['阶段记录（/stages）']}
        primaryHref="/stages"
        primaryLabel="去阶段页"
      />
    );
  }

  const targets = stages
    .filter((row) => row.id !== active.id)
    .map((row) => ({ code: row.code, label: `${row.nameZh}（${row.code}）` }));

  return <ReadinessBody view={view} asOfDate={asOfDate} stages={targets} />;
}