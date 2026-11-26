/**
 * 依据页头部：这份缺口来自**哪一次快照**、按什么规则算的、一共多少条。
 *
 * 快照是可追溯的锚点：用户点开任何一条缺口，都应该能回到「当时用的是哪份输入」
 * （`inputHash` 前 12 位足以人工比对）。
 */

import { Card } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import type { GapSummaryDto } from '@/lib/queries/planner';

export function FreshnessBar({ summary }: { summary: GapSummaryDto }) {
  const { snapshot } = summary;
  return (
    <Card
      title="依据快照"
      description={`${snapshot.purpose} · 基准日 ${snapshot.asOfDate} · 生成于 ${snapshot.createdAt.slice(0, 16).replace('T', ' ')}`}
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile tone="output" label="已证实缺口" value={summary.gapCount} unit="条" hint="证据指向的偏离" />
        <StatTile
          tone="warn"
          label="证据不足"
          value={summary.uncertaintyCount}
          unit="条"
          hint="待补测，不等于弱项"
        />
        <StatTile tone="plan" label="候选任务" value={summary.candidateCount} unit="条" hint="本快照的候选池" />
        <StatTile
          tone="neutral"
          label="规则 / 输入指纹"
          value={<span className="text-sm">{snapshot.ruleVersion}</span>}
          hint={`inputHash ${snapshot.inputHash.slice(0, 12)}`}
        />
      </div>
    </Card>
  );
}