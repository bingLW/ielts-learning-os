'use client';

/**
 * 审核页的交互容器（批量栏 + 卡片列表 + 材料级动作）。
 *
 * 为什么把材料级动作也放在这里：它们都是"需要 loading / 错误提示 / 刷新"的
 * 客户端行为，单独再拆一个组件只会让 Toast 与 loading 状态分裂成两套
 * （同一页面出现两个 `useToastState`，提示会互相盖掉）。
 *
 * 选择集只在前端：勾选不是持久状态，刷新后归零 —— 避免"昨天勾的还没提交"这种事。
 */

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import {
  bulkReviewExtractionAction,
  confirmPartialUseAction,
  continueAnalysisAction,
  regenerateMaterialSummaryAction,
} from '@/lib/actions/materialAnalysis';
import { MATERIAL_LIMITS, type MaterialStatus } from '@/lib/constants';
import type { ReviewGateResult } from '@/lib/domain/materialReviewGate';
import type { ExtractionCardDto } from '@/lib/queries/materials';
import { ExtractionCard } from './ExtractionCard';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';

const BTN_SECONDARY = `${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`;
const BTN_PRIMARY = `${BTN} border-brand bg-brand text-white hover:bg-blue-700`;
const BTN_DANGER = `${BTN} border-egRed/40 bg-egRed/10 text-egRed hover:bg-egRed/20`;

/** 与 `extractionBulkReviewSchema` 的 `max(200)` 保持一致：超了就在前端拦下。 */
const BULK_MAX = 200;

export interface BulkReviewBarProps {
  materialId: string;
  cards: ExtractionCardDto[];
  materialStatus: MaterialStatus;
  gate: ReviewGateResult;
  /** 还没分析过的 chunk 数（「继续分析」按钮要把它说清楚）。 */
  remainingChunks: number;
}

export function BulkReviewBar({
  materialId,
  cards,
  materialStatus,
  gate,
  remainingChunks,
}: BulkReviewBarProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmPartial, setConfirmPartial] = useState(false);

  const draftCards = useMemo(
    () => cards.filter((card) => card.reviewStatus === 'draft'),
    [cards],
  );
  const allDraftSelected =
    draftCards.length > 0 && selected.length === draftCards.length;

  const finish = (message: string): void => {
    show(message, 'success');
    setSelected([]);
    router.refresh();
  };

  const toggleSelect = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const toggleAll = (): void => {
    setSelected(allDraftSelected ? [] : draftCards.slice(0, BULK_MAX).map((card) => card.id));
  };

  const bulk = async (reviewStatus: 'accepted' | 'rejected'): Promise<void> => {
    if (selected.length === 0) {
      show('请先勾选要处理的结果', 'error');
      return;
    }
    if (selected.length > BULK_MAX) {
      show(`一次最多处理 ${BULK_MAX} 条，请分批处理`, 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await bulkReviewExtractionAction({
        materialId,
        ids: selected,
        reviewStatus,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      // 0 行不是错误：可能别人已经处理过
      finish(
        result.data.updated > 0
          ? `已${reviewStatus === 'accepted' ? '采纳' : '拒绝'} ${result.data.updated} 条`
          : '这些结果已被处理过，没有需要更新的行',
      );
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await regenerateMaterialSummaryAction({ materialId });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      finish(
        `已重新生成摘要（${result.data.keyPoints} 条要点通过原文核验，${result.data.droppedUnverifiable} 条被丢弃）`,
      );
    } finally {
      setBusy(false);
    }
  };

  const continueAnalysis = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await continueAnalysisAction({ materialId });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      // 续跑靠 `/processing` 的轮询驱动，跳过去让已有的 tick 循环接手
      router.push(`/materials/${materialId}/processing`);
    } finally {
      setBusy(false);
    }
  };

  const submitPartialUse = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await confirmPartialUseAction({ materialId });
      setConfirmPartial(false);
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      finish(`已转为「部分可用」（${result.data.droppedUnverifiable} 条结果已丢弃）`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* ── 闸门结论 ─────────────────────────────────────────── */}
      <div
        className={[
          'rounded-lg border p-2.5 text-[11px] leading-relaxed',
          gate.nextStatus === 'ready'
            ? 'border-egGreen/40 bg-egGreen/10 text-ink'
            : gate.requiresPartialConfirm
              ? 'border-egYellow/50 bg-egYellow/10 text-ink'
              : 'border-line bg-surfaceAlt text-ink',
        ].join(' ')}
      >
        <p className="flex items-center gap-1 font-semibold">
          <Icon name={gate.nextStatus === 'ready' ? 'check' : 'clock'} size={12} />
          {gate.reasonZh}
        </p>
        <p className="mt-0.5 text-inkMuted">
          待审核 {gate.pendingTotal} 条
          {gate.pendingTotal > 0 ? '（全部审完后材料才会进入可用状态）' : ''}
          {materialStatus === 'ready' ? ' · 材料已可用' : ''}
          {materialStatus === 'partial' ? ' · 当前按部分可用' : ''}
        </p>
      </div>

      {/* ── 批量栏 ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface p-2">
        <button type="button" onClick={toggleAll} disabled={busy || draftCards.length === 0} className={BTN_SECONDARY}>
          {allDraftSelected ? '取消全选' : `全选待审核（${draftCards.length}）`}
        </button>
        <button
          type="button"
          onClick={() => void bulk('accepted')}
          disabled={busy || selected.length === 0}
          className={`${BTN} border-egGreen/50 bg-egGreen/10 text-egGreen hover:bg-egGreen/20`}
        >
          <Icon name="check" size={11} />
          批量采纳（{selected.length}）
        </button>
        <button
          type="button"
          onClick={() => void bulk('rejected')}
          disabled={busy || selected.length === 0}
          className={BTN_DANGER}
        >
          批量拒绝
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        <button type="button" onClick={() => void regenerate()} disabled={busy} className={BTN_SECONDARY}>
          <Icon name="repeat" size={11} />
          重新生成摘要
        </button>
        {materialStatus === 'partial' && (
          <button
            type="button"
            onClick={() => void continueAnalysis()}
            disabled={busy || remainingChunks === 0}
            className={BTN_PRIMARY}
          >
            <Icon name="play" size={11} />
            {`继续分析剩余 ${remainingChunks} 块（将开始新一轮，本轮上限 ${MATERIAL_LIMITS.maxAiCalls} 次调用）`}
          </button>
        )}
        {gate.requiresPartialConfirm && materialStatus === 'review_required' && (
          <button
            type="button"
            onClick={() => setConfirmPartial(true)}
            disabled={busy}
            className={BTN_PRIMARY}
          >
            确认按部分可用继续
          </button>
        )}
        {busy && <span className="text-[11px] text-inkMuted">处理中…</span>}
      </div>

      {/* ── 结果列表 ─────────────────────────────────────────── */}
      {cards.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-surface p-4 text-xs text-inkMuted">
          这次分析没有产生任何可审核的结果。可以尝试「重新生成摘要」，或到处理页重试分析。
        </p>
      ) : (
        <div className="space-y-2">
          {cards.map((card) => (
            <ExtractionCard
              key={card.id}
              card={card}
              materialId={materialId}
              selected={selected.includes(card.id)}
              onToggleSelect={toggleSelect}
              onReviewed={finish}
              disabled={busy}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmPartial}
        title="确认按「部分可用」继续？"
        description={`${gate.reasonZh}。确认后这份材料会标记为「部分可用」——可以正常阅读与使用，但不会被当作「全部核验通过」。`}
        confirmLabel="确认部分可用"
        danger={false}
        busy={busy}
        onConfirm={() => void submitPartialUse()}
        onCancel={() => setConfirmPartial(false)}
      />

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
