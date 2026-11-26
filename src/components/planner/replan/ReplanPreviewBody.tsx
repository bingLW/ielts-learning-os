'use client';

/**
 * 重排预览与确认：先 dry-run（零写库），再以同一 token 确认。
 *
 * `initialPreview` 只用于把「预览结果」注入静态渲染（测试与服务端回放）；
 * 页面本身仍由用户点击产生预览。`hasChanges=false` 时确认按钮禁用。
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { confirmReplanAction, previewReplanAction } from '@/lib/actions/planner';
import { DiffSummary } from './DiffSummary';
import { DiffTable } from './DiffTable';
import { ProtectedNotice } from './ProtectedNotice';
import { ReasonField } from './ReasonField';
import type { ReplanContextDto } from '@/lib/queries/planner';
import type { ReplanPreviewResult } from '@/lib/services/replanPreview';

export function ReplanPreviewBody({
  context,
  initialPreview = null,
}: {
  context: ReplanContextDto;
  initialPreview?: ReplanPreviewResult | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [budget, setBudget] = useState(String(context.budget.minutes));
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ReplanPreviewResult | null>(initialPreview);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ version: number } | null>(null);

  const newBudgetMinutes = Number(budget);
  const budgetValid = Number.isFinite(newBudgetMinutes) && newBudgetMinutes >= 0 && newBudgetMinutes <= 600;

  const baseInput = () => ({
    planDate: context.planDate,
    newBudgetMinutes: Math.round(newBudgetMinutes),
    isRestDay: newBudgetMinutes === 0,
    ...(reason.trim() ? { reason: reason.trim() } : {}),
    ...(context.protectedTaskIds.length > 0 ? { lockedTaskIds: context.protectedTaskIds } : {}),
  });

  const runPreview = () => {
    if (!budgetValid) {
      setError('预算必须是 0–600 之间的整数分钟');
      return;
    }
    setError(null);
    setConfirmed(null);
    startTransition(async () => {
      const result = await previewReplanAction(baseInput());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.data);
    });
  };

  const runConfirm = () => {
    if (!preview || !preview.diff.hasChanges) return;
    setError(null);
    startTransition(async () => {
      const result = await confirmReplanAction({
        ...baseInput(),
        previewToken: preview.previewToken,
        idempotencyKey: preview.previewToken,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirmed({ version: result.data.version });
      setPreview(null);
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <Card
        title="当日重排"
        description={`计划日 ${context.planDate} · 当前预算 ${context.budget.minutes} 分钟 · 已有 ${context.versionCount} 个版本 · 实际学习 ${context.actualNetMinutes} 分钟`}
      >
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-2">
            <ProtectedNotice tasks={context.tasks} />
            <p className="text-[11px] text-inkMuted">
              重排只调整未开始/未完成任务，不删除历史任务，也不改写已完成记录。
            </p>
          </div>
          <div className="space-y-2">
            <label className="block text-xs">
              <span className="text-inkMuted">新预算（0–600 分钟，0 = 休息日）</span>
              <input
                type="number"
                min={0}
                max={600}
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
              />
            </label>
            <ReasonField value={reason} onChange={setReason} />
            <Button variant="primary" size="sm" onClick={runPreview} disabled={pending || !budgetValid}>
              {pending ? '计算中…' : '预览重排'}
            </Button>
            {error && <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
            {confirmed && (
              <p className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                已确认：版本 {confirmed.version}。本次重排已写入，旧任务保留未删除。
              </p>
            )}
          </div>
        </div>
      </Card>

      {preview && (
        <Card
          title="重排预览（未写入）"
          description={`快照 ${preview.snapshotId.slice(0, 8)} · 确认前不会改任何任务`}
          actions={
            <Button
              variant="primary"
              size="sm"
              onClick={runConfirm}
              disabled={pending || !preview.diff.hasChanges}
              data-testid="replan-confirm"
              title={preview.diff.hasChanges ? undefined : '没有变更，禁止生成空版本'}
            >
              {pending ? '写入中…' : '确认重排'}
            </Button>
          }
        >
          <DiffSummary diff={preview.diff} />
          <div className="mt-2">
            <DiffTable entries={preview.diff.entries} />
          </div>
        </Card>
      )}
    </div>
  );
}