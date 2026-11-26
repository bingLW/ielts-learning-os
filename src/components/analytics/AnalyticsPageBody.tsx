/**
 * 分析看板主体（T31：十张图）。
 *
 * 图表全部是客户端组件（Recharts 需要真实 DOM），本文件本身是服务端组件 ——
 * 这样筛选、聚合仍在服务端完成，只有「画图」这一段下沉到客户端。
 */

import Link from 'next/link';
import { AI_ROADMAP_NOTE } from '@/lib/constants';
import { formatDurationZh } from '@/lib/format';
import type {
  AiScope,
  AiSuggestionDto,
  AnalyticsDto,
  GlobalFilterDto,
  GlobalFilterOptionsDto,
} from '@/lib/types';
import { BarChartCard } from '@/components/charts/BarChartCard';
import { DonutChartCard } from '@/components/charts/DonutChartCard';
import { LineChartCard } from '@/components/charts/LineChartCard';
import { Card } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { AiPanel } from './AiPanel';
import { FilterBar } from './FilterBar';

export interface AnalyticsPageBodyProps {
  analytics: AnalyticsDto;
  filter: GlobalFilterDto;
  options: GlobalFilterOptionsDto;
  ai: { enabled: boolean; scopes: { scope: AiScope; label: string; latest: AiSuggestionDto | null }[] };
  dailyMinutes: number;
  businessDate: string;
}

/** 三色扇区（GREEN / YELLOW / RED，顺序与 egiuColors 一致）。 */
const EGIU_COLORS = ['var(--color-green)', '#b45309', 'var(--color-red)'];

export function AnalyticsPageBody({
  analytics,
  filter,
  options,
  ai,
  dailyMinutes,
  businessDate,
}: AnalyticsPageBodyProps) {
  const totalMinutes = analytics.dailyMinutes.reduce((sum, point) => sum + (point.value ?? 0), 0);
  const activeDays = analytics.dailyMinutes.filter((point) => (point.value ?? 0) > 0).length;
  const average = activeDays > 0 ? Math.round(totalMinutes / activeDays) : 0;

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-base font-semibold text-ink">分析看板</h1>
        <p className="text-xs text-inkMuted">
          {filter.from} ~ {filter.to}（{analytics.windowDays} 天）· 所有图表数据来自数据库聚合 ·{' '}
          空缺日不补 0，折线直接断开
        </p>
      </header>

      <Card title="全局筛选" description="筛选条件写在 URL 里，刷新与分享结果一致">
        <FilterBar filter={filter} options={options} businessDate={businessDate} />
      </Card>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile
          label="窗口内净时长"
          value={formatDurationZh(totalMinutes)}
          tone="actual"
          scopeNote="跨零点已按分钟拆分"
        />
        <StatTile
          label="有效学习天数"
          value={activeDays}
          unit="天"
          hint={`共 ${analytics.windowDays} 天`}
          tone="plan"
        />
        <StatTile
          label="日均（按有效天）"
          value={formatDurationZh(average)}
          tone="neutral"
          hint={`目标 ${formatDurationZh(dailyMinutes)}/天`}
        />
        <StatTile
          label="记录科目覆盖"
          value={analytics.skillHistory.filter((point) => (point.value ?? 0) > 0).length}
          unit="个"
          tone="output"
        />
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <LineChartCard
          title="每日净学习时长"
          description="只统计有效计时段（误触与挂机已剔除）"
          points={analytics.dailyMinutes}
        />
        <BarChartCard
          title="每周净学习时长"
          description="按 ISO 周汇总（周一为一周之始）"
          points={analytics.weeklyMinutes}
        />
        <BarChartCard
          title="四科与语言知识投入分布"
          description="泛听/泛读单独成桶，不并入精听/精读"
          points={analytics.skillDistribution}
          horizontal
          height={230}
          color="var(--color-brand)"
        />
        <BarChartCard
          title="阶段投入时长"
          description="按任务所属阶段归集"
          points={analytics.stageInvestment}
        />
        <DonutChartCard
          title="EGIU 三色分布"
          description="每个单元取最近一次判定（不按复测条数）"
          points={analytics.egiuColors}
          colors={EGIU_COLORS}
          emptyHint="还没有 EGIU 单元判定：去「语法诊断」录入首测"
        />
        <LineChartCard
          title="语法正确率趋势（%）"
          description="按周加权：Σ正确题数 / Σ总题数"
          points={analytics.grammarAccuracy}
          color="var(--color-green)"
          emptyHint="没有 EGIU 复测数据：录入至少两次复测才会出现趋势"
        />
        <LineChartCard
          title="词汇积累（累计词数）"
          description="按学习日累计，含三档掌握度总和"
          points={analytics.vocabGrowth}
          color="#7c3aed"
          emptyHint="词汇表为空：去「词汇」新增单词"
        />
        <LineChartCard
          title="周计划完成率（%）"
          description="按时长加权：Σ(权重×计划分钟) / Σ计划分钟"
          points={analytics.weeklyCompletion}
          emptyHint="没有计划任务：先去「学习计划」生成一天计划"
        />
        <BarChartCard
          title="错题类型分布"
          description="6 类错误类别，用于判断补规则还是补词汇"
          points={analytics.mistakeTypes}
          color="var(--color-yellow)"
        />
        <BarChartCard
          title="科目记录历史（条数）"
          description="按科目统计窗口内的学习记录条数"
          points={analytics.skillHistory}
          horizontal
          height={230}
        />
      </div>

      <AiPanel enabled={ai.enabled} scopes={ai.scopes} />

      <Card title="数据口径自检" description="这些是容易读错的四个量，写在这里避免误读">
        <ul className="space-y-1 text-[11px] text-inkMuted">
          <li>· 「净时长」只来自计时段拆分表，不含未计时的补录分钟；跨零点按分钟拆到两天。</li>
          <li>· 「完成率」按时长加权，不是「完成了几件事」；分母为 0 时显示 —，不是 0%。</li>
          <li>· 「正确率」一律加权（Σ正确/Σ总题）；不允许把多个正确率取算术平均。</li>
          <li>· 「掌握度」是三档并列，不存在单一「已掌握」合并指标。</li>
        </ul>
        <p className="mt-2 text-[11px] text-inkMuted">{AI_ROADMAP_NOTE}</p>
        <p className="mt-1 text-[11px] text-inkMuted">
          需要原始数据？<Link href="/settings" className="text-brand underline">去设置页导出</Link>
          （21 张整库表 + 5 类可读报表）。
        </p>
      </Card>
    </div>
  );
}
