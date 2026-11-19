'use client';

/**
 * 资源表格 + 归档确认。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveResourceAction } from '@/lib/actions/resources';
import { formatPercent } from '@/lib/format';
import type { ResourceRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Icon } from '@/components/ui/Icon';
import { TagBadge } from '@/components/ui/StatusBadge';

export interface ResourceTableProps {
  rows: ResourceRowDto[];
  onEdit: (row: ResourceRowDto) => void;
  onToast: (message: string, tone: 'success' | 'error') => void;
}

export function ResourceTable({ rows, onEdit, onToast }: ResourceTableProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const target = rows.find((row) => row.id === pendingId) ?? null;

  const archive = () => {
    if (!target) return;
    startTransition(async () => {
      const result = await archiveResourceAction({ id: target.id });
      setPendingId(null);
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('资源已归档', 'success');
      router.refresh();
    });
  };

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-inkMuted">
              <th className="py-1.5 pr-2 font-medium">名称</th>
              <th className="py-1.5 pr-2 font-medium">科目</th>
              <th className="py-1.5 pr-2 font-medium">类型</th>
              <th className="py-1.5 pr-2 font-medium">适用阶段</th>
              <th className="py-1.5 pr-2 font-medium">版本</th>
              <th className="py-1.5 pr-2 text-right font-medium">进度</th>
              <th className="py-1.5 pr-2 font-medium">起止</th>
              <th className="py-1.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line align-top">
                <td className="py-1.5 pr-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink">{row.name}</span>
                    {row.isPrimary && <TagBadge tone="info">主材料</TagBadge>}
                  </div>
                  {row.note && (
                    <div className="mt-0.5 max-w-[260px] truncate text-[11px] text-inkMuted">
                      {row.note}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-2">{row.subjectLabel}</td>
                <td className="whitespace-nowrap py-1.5 pr-2">{row.typeLabel}</td>
                <td className="py-1.5 pr-2 text-[11px] text-inkMuted">
                  {row.applicableStages.join(', ') || '—'}
                </td>
                <td className="py-1.5 pr-2 text-[11px] text-inkMuted">{row.version ?? '—'}</td>
                <td className="tabular py-1.5 pr-2 text-right">
                  {row.totalUnits
                    ? `${row.currentUnit ?? 0}/${row.totalUnits}（${formatPercent(
                        row.progressPercent !== null ? row.progressPercent / 100 : null,
                      )}）`
                    : '—'}
                </td>
                <td className="tabular py-1.5 pr-2 text-[11px] text-inkMuted">
                  {row.startDate ?? '—'} ~ {row.finishDate ?? '—'}
                </td>
                <td className="py-1.5">
                  <div className="flex items-center gap-1">
                    <Button variant="secondary" size="sm" onClick={() => onEdit(row)}>
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingId(row.id)}
                      aria-label={`归档 ${row.name}`}
                    >
                      <Icon name="trash" size={12} />
                    </Button>
                    {row.url && (
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded border border-line px-1.5 py-0.5 text-[11px] text-inkMuted"
                        aria-label={`打开 ${row.name} 链接`}
                      >
                        <Icon name="external" size={11} />
                      </a>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={Boolean(target)}
        title="归档这个资源？"
        description={
          target
            ? `${target.name} 将被软删除：不再出现在下拉选项中，但已关联的任务与记录仍可追溯。`
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
