/**
 * Dashboard 词汇引擎卡片（v2.3）。
 *
 * 只显示「总量 / 到期复习 / 复测到期 / 今日新词」四个可核对数字；
 * 七维掌握去 `/vocabulary` 看，这里不做任何合并口径。
 */

import Link from 'next/link';
import type { VocabDashboardSummary } from '@/lib/queries/vocabIntegration';
import { formatBusinessDateTime } from '@/lib/date';
import { Card } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';

function formatTime(iso: string | null): string {
  return iso ? formatBusinessDateTime(iso) : '—';
}

export function VocabEngineCard({ data }: { data: VocabDashboardSummary }) {
  return (
    <Card
      title="词汇引擎（v2.3）"
      description="OS 计划 + TypeWords 练习，文件交换；外部「已掌握」不计入七维"
      actions={
        <Link href="/vocabulary" className="text-[11px] text-brand hover:underline">
          词汇概览 →
        </Link>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <StatTile label="词条总量" value={data.items} unit="个" scopeNote="不含已归档" />
        <StatTile
          label="到期未复习"
          value={data.dueReview}
          unit="条"
          tone={data.dueReview > 0 ? 'warn' : 'neutral'}
          hint="昨天以前最后验证"
        />
        <StatTile
          label="复测到期"
          value={data.retestDue}
          unit="条"
          tone={data.retestDue > 0 ? 'plan' : 'neutral'}
          hint={`待完成共 ${data.retestPending} 条`}
        />
        <StatTile label="今日新词条" value={data.introducedToday} unit="个" tone="actual" />
      </div>
      <p className="mt-2 text-[11px] text-inkMuted">
        今日词汇任务：
        {data.assignment
          ? `${data.assignment.status} · 复习 ${data.assignment.reviewTarget} · 新词 ${data.assignment.newTarget}`
          : '未生成'}
        {' · '}最近练习 {formatTime(data.lastSessionAt)}
      </p>
    </Card>
  );
}
