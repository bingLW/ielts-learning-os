'use client';

/**
 * 导入失败行。
 *
 * 三件事必须在同一行里说完：**为什么失败**（人话 + 机器码）、**失败了几次**、
 * **下一步能做什么**（重试 / 删除）。重试前不要求用户重新上传（原文还在磁盘上）。
 */

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { deleteMaterialAction, retryMaterialJobAction } from '@/lib/actions/materials';
import type { FailedMaterialDto } from '@/lib/queries/materials';

export function FailedRow({
  item,
  onToast,
  onChanged,
}: {
  item: FailedMaterialDto;
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const primaryId = item.materialIds[0];

  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await retryMaterialJobAction({ materialId: primaryId });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast(`已重新排队（第 ${result.data.attempt} 次尝试），从「${result.data.fromStage}」续跑`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      // 同一 contentHash 的多条失败记录一起删（用户心智里它们是一份东西）
      let deleted = 0;
      for (const materialId of item.materialIds) {
        const result = await deleteMaterialAction({ materialId, confirmText: 'DELETE' });
        if (result.ok) deleted += 1;
      }
      onToast(deleted > 0 ? `已删除 ${deleted} 条失败记录` : '删除失败，请稍后重试', deleted > 0 ? 'success' : 'error');
      setConfirmOpen(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{item.title}</p>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            {item.formatLabel} · 失败 {item.occurrences} 次 · 最近一次 {new Date(item.lastFailedAt).toLocaleString('zh-CN')}
            {item.errorCode ? ` · ${item.errorCode}` : ''}
          </p>
          <p className="mt-1 text-xs text-egRed">{item.errorMessage ?? '处理失败，可重试'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="primary" onClick={retry} disabled={busy}>
            {busy ? '处理中…' : '重试'}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirmOpen(true)} disabled={busy}>
            删除
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={`删除「${item.title}」的失败记录？`}
        description={`将删除 ${item.materialIds.length} 条记录及其派生数据（原文文件也会一并删除）。已同步到词库的词条、已写入的计划任务与证据记录会保留。`}
        confirmLabel="确认删除"
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmOpen(false)}
      />
    </li>
  );
}
