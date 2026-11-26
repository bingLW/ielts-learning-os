'use client';

/**
 * 构建器动作条：生成预览（零写库）→ 确认（写 PlanTask + PlanVersion）。
 *
 * 预览与确认共用同一份表单值（尤其 `budgetOverrideMinutes`）：它不进
 * `PlanningSnapshot.inputHash`，但会改变落库分钟 —— 两边不一致会让
 * 「预览 == 实际」被打破，confirm 端会以 `CONFLICT` 拒绝。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button, buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { confirmPlanVersionAction, generatePlanPreviewAction, saveDraftAction } from '@/lib/actions/planner';
import type { BuildPlanPreviewResult } from '@/lib/actions/planner';
import { CarryoverPanel } from './CarryoverPanel';
import { NinetyDayTimeline } from './NinetyDayTimeline';
import { SevenDayGrid } from './SevenDayGrid';
import { ThirtyDayMatrix } from './ThirtyDayMatrix';

export function DraftActions({
  horizonDays,
  asOfDate,
  purpose,
  stageId,
  planDate,
  disabled = false,
  disabledReason,
  initialBudgetOverride,
  proposalId,
}: {
  horizonDays: number;
  asOfDate: string;
  purpose: 'GENERATE' | 'REPLAN';
  stageId?: string;
  planDate?: string;
  disabled?: boolean;
  disabledReason?: string;
  initialBudgetOverride?: number;
  proposalId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [budgetOverride, setBudgetOverride] = useState(
    initialBudgetOverride === undefined ? '' : String(initialBudgetOverride),
  );
  const [preview, setPreview] = useState<BuildPlanPreviewResult | null>(null);
  const [confirmed, setConfirmed] = useState<{
    version: number;
    versionId: string;
    warnings: string[];
    writtenTaskCount: number;
    carryover: BuildPlanPreviewResult['carryover'];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);

  const budgetOverrideMinutes = budgetOverride.trim() === '' ? undefined : Number(budgetOverride);

  const baseInput = {
    purpose,
    asOfDate,
    horizonDays,
    ...(stageId ? { stageId } : {}),
    ...(planDate ? { planDate } : {}),
    ...(budgetOverrideMinutes !== undefined && Number.isFinite(budgetOverrideMinutes)
      ? { budgetOverrideMinutes }
      : {}),
    ...(proposalId ? { proposalId } : {}),
  };

  const runPreview = () => {
    setError(null);
    setConfirmed(null);
    startTransition(async () => {
      const result = await generatePlanPreviewAction({ ...baseInput, allowAi: false });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.data);
    });
  };

  const runConfirm = () => {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const result = await confirmPlanVersionAction({
        ...baseInput,
        snapshotId: preview.snapshotId,
        previewToken: preview.previewToken,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirmed(result.data);
      setPreview(null);
      router.refresh();
    });
  };

  const runSaveDraft = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveDraftAction(baseInput);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraftId(result.data.draftId);
    });
  };

  if (disabled) {
    return (
      <Card title="生成计划">
        <p className="text-xs text-inkMuted">{disabledReason ?? '当前层级暂不可生成。'}</p>
      </Card>
    );
  }

  return (
    <Card
      title="生成计划"
      description="预览使用规则引擎、不调用 AI，也不写库；确认后才写入 PlanTask 与版本历史"
      actions={
        <span className="flex items-center gap-1.5">
          <label className="flex items-center gap-1 text-[11px] text-inkMuted">
            当日预算
            <input
              type="number"
              min={0}
              max={600}
              value={budgetOverride}
              onChange={(event) => setBudgetOverride(event.target.value)}
              placeholder="默认"
              className="w-16 rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs text-ink"
            />
            分钟
          </label>
          <Button variant="secondary" size="sm" onClick={runSaveDraft} disabled={pending}>
            保存草稿
          </Button>
          <Button variant="primary" size="sm" onClick={runPreview} disabled={pending}>
            {pending ? '计算中…' : '生成预览'}
          </Button>
        </span>
      }
    >
      {error && <p className="mb-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
      {draftId && (
        <p className="mb-2 text-xs text-inkMuted">
          草稿已保存（快照 {draftId.slice(0, 8)}）：草稿只是锚点，还没有写入任何任务。
        </p>
      )}
      {confirmed && (
        <div className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-800">
          <p>已确认：版本 {confirmed.version}，新任务 {confirmed.writtenTaskCount} 条。计划已写入，可在解释页逐条查看依据。</p>
          {confirmed.carryover && (
            <p className="mt-0.5">
              上期处理：纳入 {confirmed.carryover.promotedCount + confirmed.carryover.demotedCount} 条，
              Backlog {confirmed.carryover.backlogCount} 条，放弃 {confirmed.carryover.abandonedCount} 条。
            </p>
          )}
          {confirmed.warnings.map((warning) => (
            <p key={warning} className="mt-0.5">
              · {warning}
            </p>
          ))}
          <Link href={`/planner/explain/${confirmed.versionId}`} className="mt-1 inline-block text-brand">
            查看解释与取舍 →
          </Link>
        </div>
      )}

      {preview ? (
        <div data-testid="plan-preview" className="space-y-2">
          <p className="text-xs text-inkMuted">
            预览：{preview.days.length} 天 · 快照 {preview.snapshotId.slice(0, 8)} · 权重版本{' '}
            {preview.weightsVersion} · {preview.aiNote ?? 'AI 未参与'}
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning} className="rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
              {warning}
            </p>
          ))}
          <CarryoverPanel carryover={preview.carryover} />
          <SevenDayGrid days={preview.days} />
          {preview.layerStructure &&
            (preview.layer === 'CYCLE' ? (
              <NinetyDayTimeline structure={preview.layerStructure} />
            ) : (
              <ThirtyDayMatrix structure={preview.layerStructure} />
            ))}
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={runConfirm} disabled={pending}>
              {pending ? '写入中…' : '确认写入计划'}
            </Button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className={buttonClass('ghost', 'sm')}
            >
              放弃预览
            </button>
          </div>
        </div>
      ) : (
        !confirmed && <p className="text-xs text-inkMuted">还没有预览。点「生成预览」看看这一次会排什么。</p>
      )}
    </Card>
  );
}