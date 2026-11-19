/**
 * 顶部栏：业务日期 / 当前阶段 / 目标分 / 设置入口 / 移动端抽屉开关。
 */

import Link from 'next/link';
import { formatBand } from '@/lib/format';
import { Icon } from '@/components/ui/Icon';

export interface TopBarProps {
  todayStr: string;
  stageName: string;
  targetBand: number;
  budgetLabel: string;
  onOpenDrawer: () => void;
}

export function TopBar({
  todayStr,
  stageName,
  targetBand,
  budgetLabel,
  onOpenDrawer,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="flex items-center gap-2 px-3 py-2 tablet:px-5">
        <button
          type="button"
          onClick={onOpenDrawer}
          className="rounded-md border border-line p-1.5 text-inkMuted tablet:hidden"
          aria-label="打开导航菜单"
        >
          <Icon name="menu" size={16} />
        </button>

        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="tabular text-sm font-semibold text-ink">{todayStr}</span>
          <span className="hidden truncate text-xs text-inkMuted mobile:inline">{stageName}</span>
        </div>

        <div className="hidden items-center gap-2 text-[11px] text-inkMuted mobile:flex">
          <span className="rounded border border-line bg-surfaceAlt px-1.5 py-0.5">
            目标 Band <b className="tabular">{formatBand(targetBand)}</b>
          </span>
          <span className="rounded border border-line bg-surfaceAlt px-1.5 py-0.5">
            {budgetLabel}
          </span>
        </div>

        <Link
          href="/settings"
          className="rounded-md border border-line p-1.5 text-inkMuted hover:bg-surfaceAlt"
          aria-label="系统设置"
        >
          <Icon name="settings" size={16} />
        </Link>
      </div>
    </header>
  );
}
