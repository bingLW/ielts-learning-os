/**
 * 移动端底部导航（<1024px）。
 *
 * 5 个高频入口 + 「更多」抽屉。底部与 Chrome 移动版工具栏保持安全间距。
 */

import Link from 'next/link';
import { MOBILE_NAV_HREFS, NAV_ITEMS } from '@/lib/constants';
import { isActivePath } from './Sidebar';
import { Icon, type IconName } from '@/components/ui/Icon';

const ICON_BY_HREF: Record<string, IconName> = {
  '/': 'home',
  '/plan': 'calendar',
  '/records': 'list',
  '/mistakes': 'repeat',
  '/settings': 'settings',
};

export function MobileNav({
  pathname,
  onOpenDrawer,
}: {
  pathname: string;
  onOpenDrawer: () => void;
}) {
  const items = NAV_ITEMS.filter((item) => MOBILE_NAV_HREFS.includes(item.href));

  return (
    <nav
      aria-label="底部导航"
      className="fixed bottom-0 left-0 right-0 z-30 border-t border-line bg-surface tablet:hidden"
    >
      <ul className="flex items-stretch">
        {items.map((item) => {
          const active = isActivePath(item.href, pathname);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex flex-col items-center gap-0.5 py-1.5 text-[10px]',
                  active ? 'font-medium text-brand' : 'text-inkMuted',
                ].join(' ')}
              >
                <Icon name={ICON_BY_HREF[item.href] ?? 'circle'} size={17} />
                {item.shortZh}
              </Link>
            </li>
          );
        })}
        <li className="flex-1">
          <button
            type="button"
            onClick={onOpenDrawer}
            className="flex w-full flex-col items-center gap-0.5 py-1.5 text-[10px] text-inkMuted"
          >
            <Icon name="menu" size={17} />
            更多
          </button>
        </li>
      </ul>
    </nav>
  );
}
