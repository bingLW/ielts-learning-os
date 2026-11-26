/**
 * `/planner` 决策层首页：一屏回答「我在哪 / 今天干啥 / 系统想改什么 / 我要确认什么」。
 *
 * 未诊断时**只保留一张「先做一轮诊断」卡**：没有证据基线时，其余区块全是空壳，
 * 渲染出来只会让人以为「系统觉得我没问题」。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import type { PlannerDashboardDto } from '@/lib/queries/planner';
import { PlannerEmptyState } from '../shared/EmptyState';
import { GapUncertaintyColumns } from './GapUncertaintyColumns';
import { PendingConfirmations } from './PendingConfirmations';
import { SkillGapBars } from './SkillGapBars';
import { StatusBand } from './StatusBand';
import { TodayDecisionCard } from './TodayDecisionCard';

function BannersBlock({ banners }: Pick<PlannerDashboardDto, 'banners'>) {
  return (
    <Card title="提示与护栏" description="系统不会静默改计划：每一条都会写在这里">
      {banners.length === 0 ? (
        <p className="text-xs text-inkMuted">没有需要处理的提示。</p>
      ) : (
        <ul className="space-y-1">
          {banners.map((banner) => (
            <li
              key={banner.code}
              className={[
                'rounded-md border px-2.5 py-1.5 text-xs',
                banner.level === 'warning'
                  ? 'border-amber-300 bg-amber-50 text-amber-800'
                  : 'border-line bg-surfaceAlt text-ink',
              ].join(' ')}
            >
              {banner.text}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function DashboardBody({ data }: { data: PlannerDashboardDto }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">自适应计划</h1>
          <p className="text-xs text-inkMuted">
            基准日 {data.asOfDate} · 优先级由规则评分决定，AI 只润色措辞 · 时区 Asia/Singapore
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Link href="/planner/evidence" className="text-brand">依据与缺口 →</Link>
          <Link href="/planner/build" className="text-brand">计划构建 →</Link>
        </div>
      </div>

      {!data.diagnosed ? (
        <div data-block="no-diagnosis">
          <PlannerEmptyState
            title="先做一轮诊断"
            description="规划器只按证据排任务。没有基线时，它不会凭空生成一张「看起来合理」的计划。"
            dependencies={[
              '至少 1 条学习证据（听 / 读 / 说 / 写任意一项）',
              '或一份分项能力画像（SkillProfile）',
            ]}
          />
        </div>
      ) : (
        <>
          <div data-block="status">
            <StatusBand statusBand={data.statusBand} weeklyGap={data.weeklyGap} />
          </div>
          <div data-block="today">
            <TodayDecisionCard todayDecision={data.todayDecision} />
          </div>
          <div data-block="pending">
            <PendingConfirmations pendingConfirmations={data.pendingConfirmations} />
          </div>
          <div data-block="gaps">
            <SkillGapBars gaps={data.gapTop3} snapshotId={data.latestSnapshotId} />
          </div>
          <div data-block="uncertainty">
            <GapUncertaintyColumns gaps={data.gapTop3} uncertainties={data.uncertaintyTop3} />
          </div>
          <div data-block="banners">
            <BannersBlock banners={data.banners} />
          </div>
        </>
      )}
    </div>
  );
}