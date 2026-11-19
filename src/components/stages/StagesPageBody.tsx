'use client';

/**
 * 阶段页主体：时间线 + 验收清单 + 升级判定 + 流转日志 + 轻提示。
 */

import { DISCLAIMER_CEFR } from '@/lib/constants';
import type { AcceptanceItemDto, GateResult, GoalCardDto, StageTimelineItemDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Toast, useToastState } from '@/components/ui/Toast';
import { AcceptanceTable } from './AcceptanceTable';
import { GatePanel } from './GatePanel';
import { StageTimeline } from './StageTimeline';
import { TrackGatesPanel } from './TrackGatesPanel';

export interface TransitionLogView {
  id: string;
  fromStageCode: string | null;
  toStageCode: string;
  decidedAt: string;
  decidedBy: string;
  reason: string;
}

export function StagesPageBody({
  stages,
  activeStageId,
  activeStageName,
  acceptance,
  gate,
  logs,
  trackGoals,
}: {
  stages: StageTimelineItemDto[];
  activeStageId: string | null;
  activeStageName: string;
  acceptance: AcceptanceItemDto[];
  gate: GateResult | null;
  logs: TransitionLogView[];
  trackGoals: GoalCardDto[];
}) {
  const { toast, show, dismiss } = useToastState();
  const otherStages = stages
    .filter((stage) => stage.id !== activeStageId)
    .map((stage) => ({ id: stage.id, nameZh: stage.nameZh }));

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-base font-semibold text-ink">阶段与验收</h1>
        <p className="text-xs text-inkMuted">
          {DISCLAIMER_CEFR} · 升级必须由硬条件驱动，系统不提供「按天数自动升级」开关
        </p>
      </div>

      {stages.length === 0 ? (
        <EmptyState
          icon="flag"
          title="还没有阶段数据"
          description="阶段是计划与记录的前置依赖，请先运行 seed 初始化 4 个阶段。"
          dependencies={['prisma/seed.ts 已执行（写入 S0–S3 与 28 条验收项）']}
          primary={{ label: '去今日计划', href: '/plan' }}
        />
      ) : (
        <>
          <Card title="阶段时间线">
            <StageTimeline stages={stages} />
          </Card>

          <TrackGatesPanel goals={trackGoals} />

          {activeStageId && (
            <>
              <GatePanel
                gate={gate}
                stageId={activeStageId}
                stageName={activeStageName}
                otherStages={otherStages}
                onToast={show}
              />

              <Card
                title={`验收清单 · ${activeStageName}`}
                description="7 维度；标「必验」的 5 项全部通过才满足 H1。判定为通过/未通过时必须填写实际结果与证据。"
              >
                <AcceptanceTable
                  items={acceptance}
                  stageId={activeStageId}
                  stageName={activeStageName}
                  onToast={show}
                />
              </Card>
            </>
          )}

          <Card title="阶段流转历史" description="只增不删。">
            {logs.length === 0 ? (
              <p className="rounded-md border border-dashed border-line px-3 py-2 text-xs text-inkMuted">
                还没有手动切换过阶段。
              </p>
            ) : (
              <ul className="space-y-1">
                {logs.map((log) => (
                  <li key={log.id} className="rounded border border-line bg-surfaceAlt px-2 py-1 text-[11px]">
                    <span className="tabular text-inkMuted">
                      {log.decidedAt.slice(0, 19).replace('T', ' ')}
                    </span>
                    <span className="mx-1">
                      {log.fromStageCode ?? '（无）'} → <b>{log.toStageCode}</b>
                    </span>
                    <span className="text-inkMuted">· {log.decidedBy}</span>
                    <p className="text-ink">原因：{log.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
