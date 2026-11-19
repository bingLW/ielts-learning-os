/**
 * 字段级修订历史（最近 10 次）。
 */

import type { RevisionRowDto } from '@/lib/types';
import { truncate } from '@/lib/format';

export function RevisionList({ revisions }: { revisions: RevisionRowDto[] }) {
  if (revisions.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-line px-3 py-2 text-xs text-inkMuted">
        还没有修订记录。首次编辑后，这里会逐字段展示「改前 → 改后」，最多保留最近 10 次。
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {revisions.map((revision) => (
        <li key={revision.id} className="rounded border border-line bg-surfaceAlt p-2 text-xs">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="font-medium text-ink">{revision.fieldLabel}</span>
            <span className="tabular text-[11px] text-inkMuted">
              {revision.changedAt.slice(0, 19).replace('T', ' ')}
            </span>
          </div>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            <p className="rounded border border-red-200 bg-red-50 px-1.5 py-1 text-[11px] text-red-800">
              改前：{revision.beforeValue ? truncate(revision.beforeValue, 160) : '（空）'}
            </p>
            <p className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-1 text-[11px] text-emerald-800">
              改后：{revision.afterValue ? truncate(revision.afterValue, 160) : '（空）'}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
