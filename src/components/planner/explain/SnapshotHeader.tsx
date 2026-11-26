/**
 * 解释页头部：版本、快照、目标参照。
 *
 * 目标文本是**当前** `LearningGoal`（PlanningSnapshot 未保存目标措辞），
 * 所以标签写「当前目标」而不是「当时目标」，避免把现值伪装成历史快照。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import type { PlanExplanationDto } from '@/lib/queries/planner';

const LAYER_LABEL: Record<string, string> = {
  DAY: '日计划',
  WEEK: '周计划',
  MONTH: '月计划',
  CYCLE: '90 天周期',
};

export function SnapshotHeader({ data }: { data: PlanExplanationDto }) {
  return (
    <Card
      title={`计划解释 · ${LAYER_LABEL[data.layer] ?? data.layer} v${data.version}`}
      description={`计划日 ${data.planDate} · ${data.changeSource} · 创建于 ${data.createdAt.slice(0, 16).replace('T', ' ')}`}
      actions={
        <span className="flex items-center gap-2">
          <Link href="/planner/build" className="text-xs text-brand">
            返回构建
          </Link>
          <Link href="/planner/history" className="text-xs text-brand">
            版本历史
          </Link>
        </span>
      }
    >
      <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-[11px] text-inkMuted">快照</dt>
          <dd className="text-ink">
            {data.snapshot
              ? `${data.snapshot.asOfDate} · ${data.snapshot.ruleVersion}（${data.snapshot.id.slice(0, 8)}）`
              : data.snapshotMissing
                ? '快照已被清理'
                : '无快照（未走快照生成）'}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-inkMuted">当前目标（{data.goalRef ? '活' : '无'}）</dt>
          <dd className="text-ink">{data.goalRef ?? '尚未设置学习目标'}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-inkMuted">预算</dt>
          <dd className="text-ink">{data.budgetMinutes} 分钟</dd>
        </div>
        <div>
          <dt className="text-[11px] text-inkMuted">过期状态</dt>
          <dd className="text-ink">
            {data.staleAt
              ? `已过期（${data.staleReason ?? '上层计划发生变化'}）`
              : '有效'}
          </dd>
        </div>
      </dl>
      {data.snapshotMissing && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          这条版本引用的快照已被清理：依据与缺口不可回溯，但任务本身与当时的决策记录仍原样保留。
        </p>
      )}
    </Card>
  );
}