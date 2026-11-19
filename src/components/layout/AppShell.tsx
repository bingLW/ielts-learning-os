'use client';

/**
 * 应用外壳：桌面固定侧栏 + 移动端抽屉 + 顶部栏 + 底部导航。
 *
 * 断点策略（PRD §8）：≥1024 固定侧栏；<1024 抽屉式；<600 底部 5 项。
 */

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export interface AppShellProps {
  todayStr: string;
  stageName: string;
  targetBand: number;
  budgetLabel: string;
  children: ReactNode;
}

export function AppShell({
  todayStr,
  stageName,
  targetBand,
  budgetLabel,
  children,
}: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 路由切换后自动收起抽屉
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-[228px] shrink-0 border-r border-line bg-surface tablet:block">
        <div className="sticky top-0 h-screen">
          <Sidebar pathname={pathname} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          todayStr={todayStr}
          stageName={stageName}
          targetBand={targetBand}
          budgetLabel={budgetLabel}
          onOpenDrawer={() => setDrawerOpen(true)}
        />
        <main className="flex-1 px-3 py-3 pb-20 tablet:px-5 tablet:py-4 tablet:pb-6">
          <div className="mx-auto w-full max-w-[1320px]">{children}</div>
        </main>
      </div>

      <MobileNav pathname={pathname} onOpenDrawer={() => setDrawerOpen(true)} />

      {drawerOpen && (
        <div className="fixed inset-0 z-40 tablet:hidden" role="presentation">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="导航菜单"
            className="absolute left-0 top-0 h-full w-[248px] border-r border-line bg-surface shadow-xl"
          >
            <div className="flex justify-end p-2">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="关闭导航菜单"
                className="rounded-md border border-line p-1.5 text-inkMuted"
              >
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="h-[calc(100%-44px)]">
              <Sidebar pathname={pathname} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AppShell;
