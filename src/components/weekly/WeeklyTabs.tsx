/**
 * `/weekly` 的两个 Tab（架构 §10 决策 1）。
 *
 * PRD 有「数据分析」一级页，但导航固定 11 项且已占满 —— 因此数据分析落在
 * `/weekly?tab=analytics`，由服务端按 `searchParams.tab` 分派，**不使用客户端路由状态**，
 * 这样刷新、分享、后退都能得到同一份结果。
 *
 * 本组件是服务端组件：Tab 只用 `<Link>` 表达，不需要任何 JS 也能切换。
 */

import Link from 'next/link';

export type WeeklyTabKey = 'review' | 'analytics';

export interface WeeklyTabsProps {
  active: WeeklyTabKey;
  /** 周复盘 Tab 需要记住当前周次，否则从分析页切回来会跳回本周。 */
  isoYear: number;
  isoWeek: number;
}

interface TabDef {
  key: WeeklyTabKey;
  labelZh: string;
  hint: string;
  href: (props: WeeklyTabsProps) => string;
}

const TABS: TabDef[] = [
  {
    key: 'review',
    labelZh: '周复盘 13 项',
    hint: '系统自动填充 + 手工覆盖，Top3 必须选满 3 项',
    href: ({ isoYear, isoWeek }) => `/weekly?year=${isoYear}&week=${isoWeek}`,
  },
  {
    key: 'analytics',
    labelZh: '数据分析 10 图',
    hint: '全局筛选写在 URL 里，改条件全量重算',
    href: () => '/weekly?tab=analytics',
  },
];

export function WeeklyTabs(props: WeeklyTabsProps) {
  const { active } = props;

  return (
    <nav aria-label="周复盘与数据分析" className="flex flex-wrap gap-1.5">
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href(props)}
            aria-current={isActive ? 'page' : undefined}
            title={tab.hint}
            className={[
              'rounded border px-2.5 py-1 text-[11px] transition-colors',
              isActive
                ? 'border-brand bg-brand font-medium text-white'
                : 'border-line bg-white text-ink hover:bg-surfaceAlt',
            ].join(' ')}
          >
            {tab.labelZh}
          </Link>
        );
      })}
    </nav>
  );
}
