/**
 * 待你确认：有生成预览、但还没有 `PlanVersion.snapshotId` 指向它的请求。
 * 预览不落库（Q4），所以这里读的是快照，而不是「草稿表」。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import type { PlannerDashboardDto } from '@/lib/queries/planner';

export function PendingConfirmations({
  pendingConfirmations,
}: Pick<PlannerDashboardDto, 'pendingConfirmations'>) {
  return (
    <Card
      title="待你确认"
      description="这些生成预览尚未确认，确认后才会写入 PlanTask 与版本历史"
    >
      {pendingConfirmations.length === 0 ? (
        <p className="text-xs text-inkMuted">没有待确认的生成预览。</p>
      ) : (
        <ul className="divide-y divide-line">
          {pendingConfirmations.map((item) => (
            <li key={item.snapshotId} className="flex items-center justify-between gap-2 py-1.5 text-xs">
              <span className="min-w-0">
                <span className="block truncate text-ink">
                  {item.purpose} · 基准日 {item.asOfDate}
                </span>
                <span className="block truncate text-[11px] text-inkMuted">
                  快照 {item.snapshotId.slice(0, 8)} · 生成于 {item.createdAt.slice(0, 16).replace('T', ' ')}
                </span>
              </span>
              <Link href={`/planner/build?resume=${item.snapshotId}`} className="shrink-0 text-brand">
                去确认 →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}