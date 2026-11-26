/**
 * 被排除的候选：四组固定顺序，空组也渲染计数。
 *
 * 「为什么没排它」必须有地方可查 —— 否则用户只会看到计划里少了一条，
 * 而系统没有任何解释入口。
 */

import { Card } from '@/components/ui/Card';
import type { ExcludedReasonsDto } from '@/lib/queries/planner';

export function ExcludedReasons({ data }: { data: ExcludedReasonsDto }) {
  return (
    <Card
      title={`被排除的候选（${data.total}）`}
      description="按排除原因分组；排除发生在评分之后，决策记录仍完整保留"
    >
      <div className="grid gap-2 md:grid-cols-2">
        {data.groups.map((group) => (
          <div key={group.code} className="rounded-md border border-line">
            <p className="border-b border-line bg-surfaceAlt px-2.5 py-1 text-xs font-medium text-ink">
              {group.label}（{group.items.length}）
            </p>
            {group.items.length === 0 ? (
              <p className="px-2.5 py-1.5 text-[11px] text-inkMuted">无</p>
            ) : (
              <ul className="divide-y divide-line">
                {group.items.map((item) => (
                  <li key={`${group.code}:${item.candidateKey}`} className="px-2.5 py-1.5 text-xs">
                    <span className="block truncate text-ink" title={item.title}>
                      {item.title}
                    </span>
                    <span className="block text-[11px] text-inkMuted">
                      {item.sourceKind} · {item.module}
                      {item.reason ? ` · ${item.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}