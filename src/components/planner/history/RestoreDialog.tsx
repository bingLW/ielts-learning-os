'use client';

/**
 * 恢复版本 —— 永远是「新建一个版本」，不是把历史行改回去（append-only）。
 *
 * 两种禁止：MONTH/CYCLE 本期不支持；快照已被清理时也不恢复 —— 没有快照的
 * 「恢复」只会复制一行元数据，却容易被误读成「任务也回到了当时」，宁可不给入口。
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { restorePlanVersionAction } from '@/lib/actions/planner';

export function RestoreDialog({
  versionId,
  version,
  layer,
  hasSnapshotId,
  snapshotAvailable,
}: {
  versionId: string;
  version: number;
  layer: string;
  hasSnapshotId: boolean;
  snapshotAvailable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const blockedReason =
    layer === 'MONTH' || layer === 'CYCLE'
      ? 'MONTH / CYCLE 层版本本期不支持恢复'
      : hasSnapshotId && !snapshotAvailable
        ? '快照已清理，禁止恢复（无法复算当时输入）'
        : null;

  if (blockedReason) {
    return (
      <span className="inline-flex flex-col items-start gap-0.5">
        <Button variant="ghost" size="sm" disabled title={blockedReason} data-testid="restore-disabled">
          恢复为新版本
        </Button>
        <span className="text-[10px] text-inkMuted">{blockedReason}</span>
      </span>
    );
  }

  const restore = () => {
    const note =
      `恢复不会改动 v${version} 这一行，而是新建一个版本（append-only）。` +
      '任务实际记录不会被回滚。确认恢复？';
    if (typeof window !== 'undefined' && !window.confirm(note)) return;
    startTransition(async () => {
      const result = await restorePlanVersionAction({ versionId });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setMessage(`已生成 v${result.data.version}（v${version} 仍在历史中）`);
      router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Button variant="ghost" size="sm" onClick={restore} disabled={pending}>
        {pending ? '恢复中…' : '恢复为新版本'}
      </Button>
      {message && <span className="text-[10px] text-inkMuted">{message}</span>}
    </span>
  );
}