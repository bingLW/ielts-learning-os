'use client';

/**
 * 当日总结卡。
 *
 * 净值与完成率由服务端重新聚合后写库，前端不可传数值；这里只编辑文字草稿。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { upsertDailySummaryAction } from '@/lib/actions/task';
import { formatDurationZh, formatPercent } from '@/lib/format';
import type { DailySummaryDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { textareaClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';

export function DailySummaryCard({
  planDate,
  summary,
  netMinutes,
  completionByTime,
  onToast,
}: {
  planDate: string;
  summary: DailySummaryDto | null;
  netMinutes: number;
  completionByTime: number | null;
  onToast: (message: string, tone: 'success' | 'error') => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(summary?.draftText ?? '');

  const save = () => {
    startTransition(async () => {
      const result = await upsertDailySummaryAction({ summaryDate: planDate, draftText: draft });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('当日总结已保存', 'success');
      router.refresh();
    });
  };

  return (
    <Card
      title="当日总结"
      description="净时长与完成率由系统聚合，文字部分可自由编辑。"
      actions={
        <Button variant="primary" size="sm" onClick={save} disabled={pending}>
          <Icon name="check" size={12} />
          {pending ? '保存中…' : '保存'}
        </Button>
      }
    >
      <dl className="mb-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <div className="rounded border border-line bg-surfaceAlt p-1.5">
          <dt className="text-[11px] text-inkMuted">净学习时长</dt>
          <dd className="tabular font-medium text-ink">{formatDurationZh(netMinutes)}</dd>
        </div>
        <div className="rounded border border-line bg-surfaceAlt p-1.5">
          <dt className="text-[11px] text-inkMuted">完成率（按时长加权）</dt>
          <dd className="tabular font-medium text-ink">{formatPercent(completionByTime)}</dd>
        </div>
        <div className="rounded border border-line bg-surfaceAlt p-1.5">
          <dt className="text-[11px] text-inkMuted">任务数完成率</dt>
          <dd className="tabular font-medium text-ink">
            {formatPercent(summary?.completionRateByCount ?? null)}
          </dd>
        </div>
      </dl>

      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="今天哪些模块真的推进了？卡在哪里？明天第一件事是什么？"
        className={textareaClass}
        aria-label="当日总结草稿"
      />
    </Card>
  );
}
