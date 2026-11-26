/**
 * `/planner/build`：四层构建器。
 *
 * 页面只显示「层的状态 + 已发布版本的结构」，生成/确认全部交给 `DraftActions`。
 * 过期（stale）只标记、不自动改写 —— 用户点「重新生成」才会产出新版本。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import type { BuilderContextDto, DraftDto } from '@/lib/queries/planner';
import type { PlanLayer } from '@/lib/services/planBuild';
import { DraftActions } from './DraftActions';
import { LayerSwitcher } from './LayerSwitcher';
import { NinetyDayTimeline } from './NinetyDayTimeline';
import { ThirtyDayMatrix } from './ThirtyDayMatrix';
import { StaleBadge } from './StaleBadge';

const HORIZON_LABEL: Record<number, string> = { 1: '1 天', 7: '7 天', 30: '30 天', 90: '90 天' };

const LAYER_LABEL: Record<PlanLayer, string> = { DAY: '日计划', WEEK: '周计划', MONTH: '月计划', CYCLE: '90 天周期' };

export function PlanBuilderBody({
  context,
  horizonDays,
  draft,
}: {
  context: BuilderContextDto;
  horizonDays: number;
  draft: DraftDto | null;
}) {
  const layer = context.layer;
  const state = context.layers.find((row) => row.layer === layer);
  const noDiagnosis = !context.diagnosisReady;
  const blockedByDiagnosis = noDiagnosis && (layer === 'MONTH' || layer === 'CYCLE');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">计划构建</h1>
          <p className="text-xs text-inkMuted">
            当前：{HORIZON_LABEL[horizonDays] ?? `${horizonDays} 天`}（{LAYER_LABEL[layer]}）· 基准日{' '}
            {context.snapshot?.asOfDate ?? '无快照'} · 预算 {context.budget.minutes} 分钟
            {context.budget.isRestDay ? '（休息日）' : ''}
            {context.budget.isSuggestion ? '（仍是初始建议值）' : ''}
          </p>
        </div>
        <Link href="/planner/candidates" className="text-xs text-brand">
          先看候选队列 →
        </Link>
      </div>

      <LayerSwitcher activeHorizon={horizonDays} diagnosisReady={context.diagnosisReady} layers={context.layers} />

      {noDiagnosis && (
        <div data-testid="no-diagnosis-notice" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-medium">无诊断依据</p>
          <p className="mt-0.5">
            当前没有任何学习证据或能力画像：本次生成只能按通用模板排课，缺口与优先级不可用。
            建议先做一轮诊断，再生成计划。
          </p>
          <Link href="/diagnostics" className="mt-1 inline-block text-brand">
            先做一轮诊断 →
          </Link>
        </div>
      )}

      {draft && (
        <div data-testid="draft-banner" className="rounded-md border border-line bg-surfaceAlt px-3 py-2 text-xs text-ink">
          草稿：快照 {draft.draftId.slice(0, 8)}（{draft.purpose}，基准日 {draft.asOfDate}）—— 尚未确认，不会写入计划。
          <span className="ml-2 text-inkMuted">
            缺口 {draft.officialGapCount} · 辅助 {draft.auxiliaryGapCount} · 候选 {draft.candidateCount}
          </span>
        </div>
      )}

      {state?.staleAt && (
        <StaleBadge
          staleAt={state.staleAt}
          staleReason={state.staleReason ?? null}
          regenerateHref={`/planner/build?horizon=${horizonDays}`}
        />
      )}

      <Card
        title={`当前层状态 · ${LAYER_LABEL[layer]}`}
        description="「已过期」只表示上层变化过；旧版本仍在历史里，不会被改写"
      >
        <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-[11px] text-inkMuted">版本</dt>
            <dd className="text-ink">{state?.versionId ? `v${state.version}（${state.planDate}）` : '未生成'}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-inkMuted">状态</dt>
            <dd className="text-ink">
              {!state?.versionId ? '未生成' : state.staleAt ? '已过期' : '已发布'}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-inkMuted">预算</dt>
            <dd className="text-ink">{state?.versionId ? `${state.budgetMinutes} 分钟` : '—'}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-inkMuted">任务数</dt>
            <dd className="text-ink">{state?.versionId ? state.taskCount : '—'}</dd>
          </div>
        </dl>
      </Card>

      {(layer === 'MONTH' || layer === 'CYCLE') && state?.structure && (
        <Card title={layer === 'CYCLE' ? '90 天结构（8 项）' : '30 天结构（8 项）'} description="来自该层版本的 afterSnapshot">
          {layer === 'CYCLE' ? (
            <NinetyDayTimeline structure={state.structure} />
          ) : (
            <ThirtyDayMatrix structure={state.structure} />
          )}
        </Card>
      )}

      {blockedByDiagnosis ? (
        <Card title="生成计划">
          <p className="text-xs text-inkMuted">
            {HORIZON_LABEL[horizonDays]}层需要诊断依据（至少 1 条证据或一份能力画像）。先做一轮诊断。
          </p>
        </Card>
      ) : (
        <DraftActions
          horizonDays={horizonDays}
          asOfDate={context.snapshot?.asOfDate ?? new Date().toISOString().slice(0, 10)}
          purpose="GENERATE"
        />
      )}
    </div>
  );
}