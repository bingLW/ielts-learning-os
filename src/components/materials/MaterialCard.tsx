/**
 * 材料卡片（材料库列表项）。
 *
 * 信息层级：标题 + 状态徽章 → 元信息（格式/来源/字数/分块/时长）→ 动作。
 * 来源受限的材料在标题旁常驻警示（PRD A-05：不是一次性提示，是常驻状态）。
 */

import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { MaterialCardDto } from '@/lib/queries/materials';
import { MaterialStatusBadge, RestrictedSourceWarning } from './MaterialStatusBadge';

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function MaterialCard({ item }: { item: MaterialCardDto }) {
  const isProcessing =
    item.status !== 'ready' && item.status !== 'partial' && item.status !== 'failed' && item.status !== 'cancelled';

  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/materials/${item.id}/processing`}
              className="truncate text-sm font-semibold text-ink hover:text-brand"
            >
              {item.title}
            </Link>
            <MaterialStatusBadge status={item.status} />
            {item.restrictedSource && <RestrictedSourceWarning sourceTypeLabel={item.sourceTypeLabel} />}
            {item.duplicateOfId && (
              <span className="rounded border border-line bg-surfaceAlt px-1.5 py-0.5 text-[11px] text-inkMuted">
                副本
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-inkMuted">
            {item.formatLabel} · {item.sourceTypeLabel} · {item.charCount.toLocaleString()} 字符 ·{' '}
            {item.chunkCount} 分块
            {item.pageCount ? ` · ${item.pageCount} 页` : ''}
            {item.estimatedMinutes ? ` · 约 ${item.estimatedMinutes} 分钟` : ''} · {formatDate(item.createdAt)}
          </p>
          {item.statusReason && (
            <p className="mt-1 line-clamp-2 text-[11px] text-inkMuted">{item.statusReason}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Link href={`/materials/${item.id}/processing`} className={buttonClass('secondary', 'sm')}>
            <Icon name={isProcessing ? 'clock' : 'bookOpen'} size={13} />
            {isProcessing ? '处理状态' : '查看材料'}
          </Link>
        </div>
      </div>
    </li>
  );
}
