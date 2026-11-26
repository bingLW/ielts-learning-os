/**
 * 过期徽章：上层主题/预算变更后，下层版本只**标记**过期，不自动改写。
 *
 * 「重新生成」是链接而不是动作：用户点了才会生成新版本，旧版本原样留在历史里。
 */

import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';

export function StaleBadge({
  staleAt,
  staleReason,
  regenerateHref,
}: {
  staleAt: string | null;
  staleReason: string | null;
  regenerateHref: string;
}) {
  if (!staleAt) return null;
  return (
    <div
      data-testid="stale-badge"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900"
    >
      <span>
        计划已过期（{staleAt.slice(0, 16).replace('T', ' ')}）：{staleReason ?? '上层计划发生变化'}
        。系统不会自动改写这一版。
      </span>
      <Link href={regenerateHref} className={buttonClass('secondary', 'sm')}>
        重新生成
      </Link>
    </div>
  );
}