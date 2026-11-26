/**
 * 桌面左侧常驻导航（≥1024px）。
 *
 * 11 个一级入口按 GROUP 分组；阶段 C/D 才落地的模块**不隐藏**，而是标注
 * 「阶段 X 开放」——信息架构完整，用户不会因为找不到入口而怀疑功能缺失。
 */

import Link from 'next/link';
import { NAV_GROUP_LABEL_ZH, NAV_ITEMS, type NavItem } from '@/lib/constants';
import { Icon, type IconName } from '@/components/ui/Icon';

const ICON_BY_HREF: Record<string, IconName> = {
  '/': 'home',
  '/plan': 'calendar',
  '/records': 'list',
  '/planner': 'target',
  '/planner/build': 'calendar',
  '/planner/candidates': 'list',
  '/planner/readiness': 'flag',
  '/materials': 'bookOpen',
  '/materials/failed': 'alert',
  '/grammar': 'book',
  '/mistakes': 'repeat',
  '/vocabulary': 'type',
  '/sentences': 'quote',
  '/evidence': 'check',
  '/profile': 'target',
  '/diagnosis': 'search',
  '/listening': 'play',
  '/speaking': 'quote',
  '/coach': 'bulb',
  '/general': 'check',
  '/ielts': 'chart',
  '/mediated': 'bookOpen',
  '/cycle': 'repeat',
  '/library': 'bookOpen',
  '/stages': 'flag',
  '/weekly': 'chart',
  '/resources': 'folder',
  '/settings': 'settings',
};

/** 判断当前路径是否命中导航项。 */
export function isActivePath(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ pathname }: { pathname: string }) {
  const groups: NavItem['group'][] = ['CORE', 'PLANNER', 'MATERIALS', 'DIAGNOSE', 'TRACKS', 'ANALYZE'];

  return (
    <nav aria-label="主导航" className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-4">
      <div className="px-1">
        <p className="text-[13px] font-semibold tracking-tight text-ink">IELTS Learning OS</p>
        <p className="text-[11px] text-inkMuted">学习闭环工作台 · 时区 Asia/Singapore</p>
      </div>

      {groups.map((group) => (
        <div key={group}>
          <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-inkMuted">
            {NAV_GROUP_LABEL_ZH[group]}
          </p>
          <ul className="space-y-0.5">
            {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
              const active = isActivePath(item.href, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors',
                      active
                        ? 'bg-blue-50 font-medium text-brand'
                        : 'text-ink hover:bg-surfaceAlt',
                    ].join(' ')}
                  >
                    <Icon
                      name={ICON_BY_HREF[item.href] ?? 'circle'}
                      size={15}
                      className={active ? 'text-brand' : 'text-inkMuted'}
                    />
                    <span className="truncate">{item.labelZh}</span>
                    {item.pendingPhase && (
                      <span
                        title={item.pendingPhase}
                        className="ml-auto shrink-0 rounded bg-slate-100 px-1 text-[10px] text-slate-500"
                      >
                        待开放
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <div className="mt-auto rounded-md border border-line bg-surfaceAlt p-2 text-[10px] leading-relaxed text-inkMuted">
        阶段对应关系为学习路径规划，非 CEFR 官方认证或测评结果。
      </div>
    </nav>
  );
}
