/**
 * `/weekly` 周复盘 + 数据分析（架构 §7 T33/T34、§10 决策 1）。
 *
 * 同一路由承载两个 Tab：
 * - `?year=&week=`（默认）→ 13 项指标周复盘；
 * - `?tab=analytics` → 十张图分析看板。
 *
 * **为什么不是两个一级路由**：导航固定 11 项且已占满（架构 §10-1），
 * 因此分析看板作为 Tab 存在，由 `searchParams.tab` 在**服务端**分派，
 * 不使用客户端路由状态 —— 刷新/分享/后退结果一致。
 */

import { getAiPanel } from '@/lib/queries/ai';
import { getAnalytics, getDailyMinutesBudget } from '@/lib/queries/analytics';
import { getGlobalFilterOptions, parseGlobalFilter, type RawSearchParams } from '@/lib/queries/filters';
import { getMistakeStats } from '@/lib/queries/mistakes';
import {
  currentIsoWeek,
  getWeeklyBudget,
  getWeeklyDelta,
  getWeeklyReview,
  getWeeklyTrackStats,
  listWeekOptions,
} from '@/lib/queries/weekly';
import { AnalyticsPageBody } from '@/components/analytics/AnalyticsPageBody';
import { WeeklyPageBody } from '@/components/weekly/WeeklyPageBody';
import { WeeklyTabs, type WeeklyTabKey } from '@/components/weekly/WeeklyTabs';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<RawSearchParams>;
}

const TAB_QUERY_KEY = 'tab';
const ANALYTICS_TAB: WeeklyTabKey = 'analytics';

function one(params: RawSearchParams, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** 解析周次；非法输入一律回落到「本周」，绝不因为手改 URL 而报错。 */
function parseWeek(params: RawSearchParams): { isoYear: number; isoWeek: number } {
  const current = currentIsoWeek();
  const yearRaw = Number(one(params, 'year'));
  const weekRaw = Number(one(params, 'week'));
  const isoYear =
    Number.isFinite(yearRaw) && yearRaw >= 2000 && yearRaw <= 2999
      ? Math.round(yearRaw)
      : current.isoYear;
  const isoWeek =
    Number.isFinite(weekRaw) && weekRaw >= 1 && weekRaw <= 53 ? Math.round(weekRaw) : current.isoWeek;
  return { isoYear, isoWeek };
}

export default async function WeeklyPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const tab: WeeklyTabKey = one(params, TAB_QUERY_KEY) === ANALYTICS_TAB ? ANALYTICS_TAB : 'review';
  const { isoYear, isoWeek } = parseWeek(params);

  if (tab === ANALYTICS_TAB) {
    const filter = parseGlobalFilter(params);
    const [analytics, options, ai, dailyMinutes] = await Promise.all([
      getAnalytics(filter),
      getGlobalFilterOptions(),
      getAiPanel(),
      getDailyMinutesBudget(),
    ]);

    return (
      <div className="space-y-3">
        <WeeklyTabs active={tab} isoYear={isoYear} isoWeek={isoWeek} />
        <AnalyticsPageBody
          analytics={analytics}
          filter={filter}
          options={options}
          ai={ai}
          dailyMinutes={dailyMinutes}
        />
      </div>
    );
  }

  const current = currentIsoWeek();
  const [review, options, mistakeStats, trackStats, budget, delta] = await Promise.all([
    getWeeklyReview(isoYear, isoWeek),
    listWeekOptions(10),
    getMistakeStats(),
    getWeeklyTrackStats(isoYear, isoWeek),
    getWeeklyBudget(isoYear, isoWeek),
    getWeeklyDelta(isoYear, isoWeek),
  ]);

  return (
    <div className="space-y-3">
      <WeeklyTabs active={tab} isoYear={isoYear} isoWeek={isoWeek} />
      <WeeklyPageBody
        review={review}
        options={options}
        suggestions={mistakeStats.topKnowledgePoints.map((item) => item.name)}
        isCurrentWeek={isoYear === current.isoYear && isoWeek === current.isoWeek}
        trackStats={trackStats.stats}
        budget={budget}
        delta={delta.delta}
      />
    </div>
  );
}
