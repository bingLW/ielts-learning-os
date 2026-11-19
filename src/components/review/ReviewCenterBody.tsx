'use client';

/**
 * 复习中心主体（T28）。
 *
 * 交互原则：
 * - 每条任务都能单独「通过 / 未通过 / 延期 / 跳过」；
 * - 支持勾选批量「全部通过」「批量延期」；
 * - 延期不改原到期日，只追加新点（UI 明确写出这一点，避免用户误会）。
 */

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  batchReviewAction,
  completeReviewTaskAction,
  postponeReviewTaskAction,
  skipReviewTaskAction,
} from '@/lib/actions/review';
import { BATCH_REVIEW_MAX } from '@/lib/constants';
import { formatDurationZh } from '@/lib/format';
import type { ReviewCenterDto, ReviewTaskRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatTile } from '@/components/ui/StatTile';
import { TagBadge } from '@/components/ui/StatusBadge';
import { Toast, useToastState } from '@/components/ui/Toast';

/** 目标类型 → 详情页链接（复习完能直接跳过去补记录）。 */
function targetHref(task: ReviewTaskRowDto): string | null {
  if (task.targetType === 'EGIU_LESSON') return `/grammar/${task.targetId}`;
  if (task.targetType === 'MISTAKE') return '/mistakes';
  if (task.targetType === 'VOCAB_WORD') return '/vocabulary';
  return null;
}

export function ReviewCenterBody({ center }: { center: ReviewCenterDto }) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string[]>([]);

  const allVisible = useMemo(
    () => center.buckets.flatMap((bucket) => bucket.items),
    [center.buckets],
  );

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const run = (fn: () => Promise<void>) => {
    startTransition(async () => {
      await fn();
      router.refresh();
    });
  };

  const completeOne = (task: ReviewTaskRowDto, result: 'PASS' | 'FAIL') =>
    run(async () => {
      const response = await completeReviewTaskAction({ id: task.id, result });
      show(response.ok ? `已记录：${task.targetLabel}` : response.error, response.ok ? 'success' : 'error');
    });

  const postponeOne = (task: ReviewTaskRowDto) =>
    run(async () => {
      const response = await postponeReviewTaskAction({ id: task.id });
      show(
        response.ok
          ? `已延期到 ${response.data.dueDate}（原到期日不变）`
          : response.error,
        response.ok ? 'success' : 'error',
      );
    });

  const skipOne = (task: ReviewTaskRowDto) =>
    run(async () => {
      const response = await skipReviewTaskAction({ id: task.id, reason: '本次不复习' });
      show(response.ok ? '已跳过' : response.error, response.ok ? 'success' : 'error');
    });

  const batch = (op: 'COMPLETE_PASS' | 'POSTPONE') =>
    run(async () => {
      const ids = selected.slice(0, BATCH_REVIEW_MAX);
      const response = await batchReviewAction({ ids, op });
      if (response.ok) {
        show(`批量操作完成：${response.data.affected} 条`, 'success');
        setSelected([]);
      } else {
        show(response.error, 'error');
      }
    });

  const isEmpty = allVisible.length === 0;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">复习中心</h1>
          <p className="text-xs text-inkMuted">
            四类目标共用一张复习任务表 · 逾期不会消失也不会改期 · 今天 {center.today}
          </p>
        </div>
        <Link href="/mistakes" className="text-[11px] text-brand hover:underline">
          去做错题 →
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile label="逾期" value={center.overdueCount} unit="条" tone="warn" />
        <StatTile label="今日到期" value={center.dueTodayCount} unit="条" tone="plan" />
        <StatTile label="本周内到期" value={center.weekCount} unit="条" tone="neutral" />
        <StatTile
          label="预估复习时长"
          value={formatDurationZh(center.totalEstMinutes)}
          tone="actual"
          hint={center.loadHeavy ? '复习负载偏重（>可用时长 25%）' : undefined}
          scopeNote={`可用时长 ${formatDurationZh(center.dailyMinutes)}/天`}
        />
      </div>

      {center.loadHeavy && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          复习负载超过可用时长的 25%。系统不会自动截断任务，但建议优先做红灯单元的 D1/D3。
        </div>
      )}

      {isEmpty ? (
        <EmptyState
          icon="repeat"
          title="今天没有待复习任务"
          description="复习点由 EGIU 判定、错题与词汇抽测自动生成。没有任务说明当前没有到期的复习点 —— 这是好事。"
          dependencies={['至少有一条 EGIU 黄/红灯判定，或存在未掌握错题']}
          primary={{ label: '去语法诊断', href: '/grammar' }}
          secondary={{ label: '去错题本', href: '/mistakes' }}
        />
      ) : (
        <>
          <Card
            title="批量操作"
            description={`已选 ${selected.length} 条（单次上限 ${BATCH_REVIEW_MAX}）`}
            actions={
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={selected.length === 0 || pending}
                  onClick={() => batch('COMPLETE_PASS')}
                >
                  批量通过
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={selected.length === 0 || pending}
                  onClick={() => batch('POSTPONE')}
                >
                  批量延期
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                  清空选择
                </Button>
              </>
            }
          >
            <p className="text-[11px] text-inkMuted">
              「延期」不会修改原到期日：原记录标为已跳过并保留原因，另追加一条 2 天后的新点。
            </p>
          </Card>

          {center.buckets.map((bucket) => (
            <Card
              key={bucket.key}
              title={`${bucket.title}（${bucket.items.length}）`}
              description={`${bucket.hint} · 预估 ${formatDurationZh(bucket.estMinutes)}`}
            >
              {bucket.items.length === 0 ? (
                <p className="py-2 text-center text-[11px] text-inkMuted">这一桶是空的。</p>
              ) : (
                <ul className="space-y-1.5">
                  {bucket.items.map((task) => (
                    <li
                      key={task.id}
                      className="rounded-md border border-line bg-white px-2.5 py-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <label className="flex min-w-0 items-start gap-2">
                          <input
                            type="checkbox"
                            checked={selected.includes(task.id)}
                            onChange={() => toggle(task.id)}
                            aria-label={`选择 ${task.targetLabel}`}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="block text-xs font-medium text-ink">
                              {targetHref(task) ? (
                                <Link href={targetHref(task) as string} className="text-brand hover:underline">
                                  {task.targetLabel}
                                </Link>
                              ) : (
                                task.targetLabel
                              )}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-inkMuted">
                              <TagBadge>{task.targetTypeLabel}</TagBadge>
                              <TagBadge tone="info">{task.intervalLabel}</TagBadge>
                              <span>到期 {task.dueDate}</span>
                              {task.isOverdue && (
                                <TagBadge tone="warn">逾期 {task.overdueDays} 天</TagBadge>
                              )}
                              {task.knowledgePoint && <span>· {task.knowledgePoint}</span>}
                            </span>
                          </span>
                        </label>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={pending}
                            onClick={() => completeOne(task, 'PASS')}
                          >
                            通过
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => completeOne(task, 'FAIL')}
                          >
                            未通过
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => postponeOne(task)}
                          >
                            延期
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => skipOne(task)}
                          >
                            跳过
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </>
      )}

      <Card
        title={`30 天低频池（${center.lowFreq.length}）`}
        description="已掌握的单元/单词转入低频抽测，不影响日常队列"
      >
        {center.lowFreq.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-inkMuted">暂无低频抽测任务。</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {center.lowFreq.map((task) => (
              <li key={task.id} className="rounded border border-line bg-surfaceAlt px-2 py-1 text-[11px]">
                {task.targetLabel} · {task.dueDate}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
