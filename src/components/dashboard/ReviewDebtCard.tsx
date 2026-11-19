/**
 * Dashboard ⑦ 待复习：今日到期 / 逾期 / 未来 7 天。
 *
 * 逾期条目必须可见且不会被静默丢弃（护栏 G4）。
 */

import Link from 'next/link';
import type { ReviewDebtDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';

export function ReviewDebtCard({ data }: { data: ReviewDebtDto }) {
  const empty = data.dueToday === 0 && data.overdue === 0 && data.next7Days === 0;

  return (
    <Card
      title="待复习"
      description="统一复习调度：EGIU 单元 / 错题 / 单词 / 语法点共用一张表。"
      actions={
        <Link href="/mistakes" className="text-[11px] text-brand hover:underline">
          去复习队列 →
        </Link>
      }
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <StatTile label="今日到期" value={data.dueToday} unit="条" tone="plan" />
        <StatTile
          label="逾期"
          value={data.overdue}
          unit="条"
          tone={data.overdue > 0 ? 'warn' : 'neutral'}
          hint="逾期不消失，且不后移后续复习点"
        />
        <StatTile label="未来 7 天" value={data.next7Days} unit="条" tone="neutral" />
      </div>

      {data.overdueItems.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {data.overdueItems.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900"
            >
              <span className="truncate">{item.label}</span>
              <span className="tabular shrink-0">
                {item.intervalCode} · 逾期 {item.overdueDays} 天
              </span>
            </li>
          ))}
        </ul>
      )}

      {empty && (
        <p className="mt-2 text-[11px] text-inkMuted">
          当前没有待复习任务。EGIU 单元判黄/红、错题建立后会自动排程。
        </p>
      )}
    </Card>
  );
}
