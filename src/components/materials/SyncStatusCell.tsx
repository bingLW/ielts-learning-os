/**
 * 同步状态单元格（T12）。
 *
 * 为什么单独一个组件：同步状态是"这个词到底进没进词库"的唯一答案，它出现在
 * 候选行的每一行、也会出现在将来的其它列表里。三处各写一份 `if/else` 配色，
 * 迟早会出现"同一个 failed 在两页里颜色不同"。
 *
 * 刻意做成**无状态组件**（不 `'use client'`）：它只渲染 props，跟着父组件
 * 一起进客户端包即可，不需要自己的交互。
 */

import type { MaterialSyncStatus } from '@/lib/constants';

/** 每种同步状态的配色（与材料状态徽章的色板一致：绿=成功、红=失败、灰=未动）。 */
const TONE: Record<MaterialSyncStatus, string> = {
  pending: 'border-line bg-surfaceAlt text-inkMuted',
  synced: 'border-egGreen/40 bg-egGreen/10 text-egGreen',
  skipped: 'border-line bg-surfaceAlt text-inkMuted',
  failed: 'border-egRed/40 bg-egRed/10 text-egRed',
};

export interface SyncStatusCellProps {
  status: MaterialSyncStatus;
  /** 中文标签（由查询层给出，避免前端再写一份映射）。 */
  statusLabel: string;
  /** 失败原因（人话，≤200 字，已脱敏）。 */
  error: string | null;
  /** 主库是否已有同键词条（现查结果）。 */
  existsInLibrary: boolean;
  /** 主库现有释义（只读：同步不会覆盖它）。 */
  libraryDefinitionZh: string | null;
}

export function SyncStatusCell({
  status,
  statusLabel,
  error,
  existsInLibrary,
  libraryDefinitionZh,
}: SyncStatusCellProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-1">
        <span className={`rounded border px-1 py-0.5 text-[10px] ${TONE[status]}`}>
          {statusLabel}
        </span>
        {existsInLibrary && (
          <span
            className="rounded border border-brand/40 bg-brand/10 px-1 py-0.5 text-[10px] text-brand"
            title="同步时只会追加「来自材料」这一来源，不会改动主库已有释义"
          >
            词库已有 · 只加来源
          </span>
        )}
      </span>

      {existsInLibrary && libraryDefinitionZh && (
        <span className="text-[10px] leading-relaxed text-inkMuted">
          主库释义：{libraryDefinitionZh}
        </span>
      )}

      {status === 'failed' && error && (
        <span className="text-[10px] leading-relaxed text-egRed">{error}</span>
      )}
    </div>
  );
}
