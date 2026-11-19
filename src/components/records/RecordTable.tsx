/**
 * 记录表格。
 *
 * 移动端降级为卡片流（PRD §8：<600 表格转卡片），桌面端保留完整表格。
 * 删除入口一律走二次确认。
 */

'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveStudyRecordAction } from '@/lib/actions/records';
import { TRACK_LABEL_ZH } from '@/lib/constants';
import { formatDurationZh, formatPercent, truncate } from '@/lib/format';
import type { StudyRecordRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Icon } from '@/components/ui/Icon';
import { StatusBadge } from '@/components/ui/StatusBadge';

export interface RecordTableProps {
  rows: StudyRecordRowDto[];
  onToast: (message: string, tone: 'success' | 'error') => void;
}

export function RecordTable({ rows, onToast }: RecordTableProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const target = rows.find((row) => row.id === pendingId) ?? null;

  const archive = () => {
    if (!target) return;
    startTransition(async () => {
      const result = await archiveStudyRecordAction({ id: target.id });
      setPendingId(null);
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('记录已归档（软删除，可追溯）', 'success');
      router.refresh();
    });
  };

  return (
    <>
      {/* 桌面：表格 */}
      <div className="hidden overflow-x-auto mobile:block">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-inkMuted">
              <th className="py-1.5 pr-2 font-medium">日期</th>
              <th className="py-1.5 pr-2 font-medium">轨道</th>
              <th className="py-1.5 pr-2 font-medium">科目</th>
              <th className="py-1.5 pr-2 font-medium">内容</th>
              <th className="py-1.5 pr-2 font-medium">资源</th>
              <th className="py-1.5 pr-2 text-right font-medium">计划</th>
              <th className="py-1.5 pr-2 text-right font-medium">实际</th>
              <th className="py-1.5 pr-2 text-right font-medium">正确率</th>
              <th className="py-1.5 pr-2 font-medium">状态</th>
              <th className="py-1.5 pr-2 font-medium">产出</th>
              <th className="py-1.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line align-top">
                <td className="tabular whitespace-nowrap py-1.5 pr-2">{row.recordDate}</td>
                <td className="whitespace-nowrap py-1.5 pr-2">
                  <span className="rounded bg-surfaceAlt px-1 py-0.5 text-[11px] text-inkMuted">
                    {TRACK_LABEL_ZH[row.track]}
                  </span>
                </td>
                <td className="whitespace-nowrap py-1.5 pr-2">{row.skillLabel}</td>
                <td className="py-1.5 pr-2">
                  <Link href={`/records/${row.id}`} className="text-brand hover:underline">
                    {truncate(row.content, 40)}
                  </Link>
                  {row.chapter && (
                    <div className="text-[11px] text-inkMuted">{row.chapter}</div>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-[11px] text-inkMuted">
                  {row.resourceName ?? '—'}
                </td>
                <td className="tabular py-1.5 pr-2 text-right">
                  {formatDurationZh(row.plannedMinutes)}
                </td>
                <td className="tabular py-1.5 pr-2 text-right">
                  {formatDurationZh(row.actualMinutes)}
                </td>
                <td className="tabular py-1.5 pr-2 text-right">
                  {row.totalQuestions > 0
                    ? `${formatPercent(row.accuracy)} (${row.correctQuestions}/${row.totalQuestions})`
                    : '—'}
                </td>
                <td className="py-1.5 pr-2">
                  <StatusBadge status={row.status} />
                </td>
                <td className="py-1.5 pr-2 text-[11px]">
                  {row.hasOutput ? (
                    <span className="text-emerald-700">有</span>
                  ) : (
                    <span className="text-amber-700">缺</span>
                  )}
                </td>
                <td className="py-1.5">
                  <div className="flex items-center gap-1">
                    <Link
                      href={`/records/${row.id}`}
                      className="rounded border border-line px-1.5 py-0.5 text-[11px] text-inkMuted hover:bg-surfaceAlt"
                    >
                      详情
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingId(row.id)}
                      aria-label="归档记录"
                    >
                      <Icon name="trash" size={12} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 移动：卡片流 */}
      <ul className="space-y-2 mobile:hidden">
        {rows.map((row) => (
          <li key={row.id} className="rounded-md border border-line bg-surface p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="tabular text-[11px] text-inkMuted">{row.recordDate}</span>
                  <span className="rounded bg-surfaceAlt px-1 py-0.5 text-[10px] text-inkMuted">
                    {TRACK_LABEL_ZH[row.track]}
                  </span>
                  <span className="text-[11px] font-medium text-ink">{row.skillLabel}</span>
                </div>
                <Link href={`/records/${row.id}`} className="mt-0.5 block text-xs text-brand">
                  {truncate(row.content, 60)}
                </Link>
              </div>
              <StatusBadge status={row.status} />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-inkMuted">
              <span>计划 {formatDurationZh(row.plannedMinutes)}</span>
              <span>实际 {formatDurationZh(row.actualMinutes)}</span>
              <span>
                正确率{' '}
                {row.totalQuestions > 0
                  ? `${formatPercent(row.accuracy)} (${row.correctQuestions}/${row.totalQuestions})`
                  : '—'}
              </span>
              <span>产出 {row.hasOutput ? '有' : '缺'}</span>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <Link
                href={`/records/${row.id}`}
                className="rounded border border-line px-1.5 py-0.5 text-[11px]"
              >
                详情
              </Link>
              <Button variant="ghost" size="sm" onClick={() => setPendingId(row.id)}>
                归档
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={Boolean(target)}
        title="归档这条学习记录？"
        description={
          target
            ? `${target.recordDate} · ${target.skillLabel} · ${truncate(target.content, 30)}。归档为软删除，数据仍可追溯，但不再计入统计。`
            : undefined
        }
        confirmLabel={pending ? '处理中…' : '确认归档'}
        busy={pending}
        onCancel={() => setPendingId(null)}
        onConfirm={archive}
      />
    </>
  );
}
