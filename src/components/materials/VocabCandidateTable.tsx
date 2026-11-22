'use client';

/**
 * 词汇候选审核台（T12）。
 *
 * 三件事放在一起，因为它们是一条链：**审 → 同步 → 看结果**。
 * - 审核：逐条采纳/修改/拒绝，或勾选批量采纳；
 * - 同步：把已采纳的写进主库（已有词条只加来源）；
 * - 结果：每条自带同步状态，失败可一键重试。
 *
 * 筛选走 URL（`?status=draft`）而不是本地 state：和阅读器的模式切换同一口径，
 * 刷新、收藏、返回都能保持同一个视图。
 */

import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import {
  bulkAcceptVocabularyCandidatesAction,
  materializeVocabularyCandidatesAction,
  retryVocabularySyncAction,
  syncVocabularyCandidatesAction,
} from '@/lib/actions/materialVocabulary';
import type { MaterialStatus } from '@/lib/constants';
import type {
  MaterialVocabSummaryDto,
  VocabCandidateDto,
  VocabCandidateFilter,
} from '@/lib/queries/materials';
import { CandidateRow } from './CandidateRow';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';

const BTN_SECONDARY = `${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`;
const BTN_PRIMARY = `${BTN} border-brand bg-brand text-white hover:bg-blue-700`;
const BTN_ACCEPT = `${BTN} border-egGreen/50 bg-egGreen/10 text-egGreen hover:bg-egGreen/20`;
const BTN_WARN = `${BTN} border-egYellow/60 bg-egYellow/10 text-egYellow hover:bg-egYellow/20`;

/** 与 `vocabCandidateBulkSchema` / `vocabCandidateSyncSchema` 的 `max(200)` 一致。 */
const BULK_MAX = 200;

const FILTER_LABELS: Record<VocabCandidateFilter, string> = {
  all: '全部',
  draft: '待审核',
  accepted: '已采纳',
  edited: '已修改采纳',
  rejected: '已拒绝',
};

export interface VocabCandidateTableProps {
  materialId: string;
  materialStatus: MaterialStatus;
  summary: MaterialVocabSummaryDto;
  candidates: VocabCandidateDto[];
  filter: VocabCandidateFilter;
}

export function VocabCandidateTable({
  materialId,
  materialStatus,
  summary,
  candidates,
  filter,
}: VocabCandidateTableProps) {
  const { toast, show, dismiss } = useToastState();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const draftIds = useMemo(
    () => candidates.filter((row) => row.reviewStatus === 'draft').map((row) => row.id),
    [candidates],
  );
  const syncableCount = summary.pending + summary.failed;
  const allDraftSelected = draftIds.length > 0 && selected.length === draftIds.length;

  /** 材料还在处理中时只能看，不能改（与 action 的前置断言同一口径）。 */
  const readonly = !['review_required', 'ready', 'partial'].includes(materialStatus);

  const finish = (message: string): void => {
    show(message, 'success');
    setSelected([]);
  };

  const toggleSelect = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const toggleAll = (): void => {
    setSelected(allDraftSelected ? [] : draftIds.slice(0, BULK_MAX));
  };

  const bulkAccept = async (): Promise<void> => {
    if (selected.length === 0) {
      show('请先勾选要采纳的候选', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await bulkAcceptVocabularyCandidatesAction({ materialId, ids: selected });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      finish(
        result.data.updated > 0
          ? `已采纳 ${result.data.updated} 条候选`
          : '这些候选已被处理过，没有需要更新的行',
      );
    } finally {
      setBusy(false);
    }
  };

  const sync = async (): Promise<void> => {
    setBusy(true);
    try {
      // 勾了就只同步勾的；没勾就同步全部已采纳且待同步/失败的
      const result = await syncVocabularyCandidatesAction({
        materialId,
        ...(selected.length > 0 ? { ids: selected.slice(0, BULK_MAX) } : {}),
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      const { created, linked, skipped, failed, legacyMatched } = result.data;
      finish(
        `同步完成：新建 ${created} 个词条 · 只加来源 ${linked} 条 · 跳过 ${skipped} 条`
        + (legacyMatched > 0 ? ` · 其中 ${legacyMatched} 条按原词形匹配到历史词条` : '')
        + (failed > 0 ? ` · 失败 ${failed} 条（可点「重试失败项」）` : ''),
      );
    } finally {
      setBusy(false);
    }
  };

  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await retryVocabularySyncAction({ materialId });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      const { reset, created, linked, failed, legacyMatched } = result.data;
      finish(
        `已重置 ${reset} 条失败项：新建 ${created} 个词条 · 只加来源 ${linked} 条`
        + (legacyMatched > 0 ? ` · 其中 ${legacyMatched} 条按原词形匹配到历史词条` : '')
        + (failed > 0 ? ` · 仍失败 ${failed} 条` : ''),
      );
    } finally {
      setBusy(false);
    }
  };

  const materialize = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await materializeVocabularyCandidatesAction({ materialId });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      const { created, duplicates, skippedNoLemma, skippedUnverifiable } = result.data;
      finish(
        created > 0
          ? `已补建 ${created} 条候选（重复 ${duplicates} · 无词条 ${skippedNoLemma} · 依据不通过 ${skippedUnverifiable}）`
          : `没有新增候选（重复 ${duplicates} · 无词条 ${skippedNoLemma} · 依据不通过 ${skippedUnverifiable}）`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* ── 汇总条 ─────────────────────────────────────────── */}
      <div className="rounded-lg border border-line bg-surface p-2.5">
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink">
          <Icon name="bulb" size={12} />
          <span className="font-semibold">词汇候选</span>
          <span className="text-inkMuted">
            共 {summary.total} 条 · 待审核 {summary.draft} · 已采纳 {summary.accepted} ·
            已拒绝 {summary.rejected} · 词库已有 {summary.existsInLibrary}
          </span>
        </p>
        <p className="mt-1 text-[11px] text-inkMuted">
          同步：待同步 {summary.pending} · 已同步 {summary.synced} · 失败 {summary.failed} ·
          跳过 {summary.skipped}
          {summary.total === 0 && '　（还没有候选：先在「AI 分析」页采纳关键词，或点下面的补建按钮）'}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void sync()}
            disabled={busy || readonly || syncableCount === 0}
            className={BTN_PRIMARY}
          >
            <Icon name="repeat" size={11} />
            {selected.length > 0 ? `同步选中（${selected.length}）` : '同步全部已采纳'}
          </button>
          {summary.failed > 0 && (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={busy || readonly}
              className={BTN_WARN}
            >
              重试失败项（{summary.failed}）
            </button>
          )}
          <button
            type="button"
            onClick={() => void materialize()}
            disabled={busy || readonly}
            className={BTN_SECONDARY}
            title="把已采纳的关键词/搭配结果补建成候选（幂等，重复点不会重复建）"
          >
            从已审核的分析结果补建候选
          </button>
          {summary.synced > 0 && (
            <a href="/vocabulary" className={BTN_SECONDARY}>
              去词库查看
            </a>
          )}
          {busy && <span className="text-[11px] text-inkMuted">处理中…</span>}
        </div>
      </div>

      {/* ── 筛选 + 批量栏 ──────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(Object.keys(FILTER_LABELS) as VocabCandidateFilter[]).map((value) => (
          <a
            key={value}
            href={`/materials/${materialId}/vocabulary${value === 'all' ? '' : `?status=${value}`}`}
            aria-current={filter === value ? 'page' : undefined}
            className={`${BTN} ${
              filter === value
                ? 'border-brand bg-brand text-white'
                : 'border-line bg-surface text-ink hover:bg-surfaceAlt'
            }`}
          >
            {FILTER_LABELS[value]}
          </a>
        ))}
      </div>

      {draftIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface p-2">
          <button
            type="button"
            onClick={toggleAll}
            disabled={busy || readonly}
            className={BTN_SECONDARY}
          >
            {allDraftSelected ? '取消全选' : `全选待审核（${draftIds.length}）`}
          </button>
          <button
            type="button"
            onClick={() => void bulkAccept()}
            disabled={busy || readonly || selected.length === 0}
            className={BTN_ACCEPT}
          >
            <Icon name="check" size={11} />
            批量采纳（{selected.length}）
          </button>
          <span className="text-[11px] text-inkMuted">
            批量采纳只处理「待审核」状态；一次最多 {BULK_MAX} 条
          </span>
        </div>
      )}

      {/* ── 列表 ─────────────────────────────────────────── */}
      {candidates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-surface p-4 text-xs leading-relaxed text-inkMuted">
          {filter === 'all'
            ? '这份材料还没有词汇候选。候选来自「已采纳」的关键词/搭配结果：先在 AI 分析页采纳，或点上面的「补建」按钮。'
            : '这个筛选下没有候选，换个筛选看看。'}
        </p>
      ) : (
        <div className="space-y-2">
          {candidates.map((candidate) => (
            <CandidateRow
              key={candidate.id}
              candidate={candidate}
              materialId={materialId}
              selected={selected.includes(candidate.id)}
              onToggleSelect={toggleSelect}
              onReviewed={finish}
              disabled={busy || readonly}
            />
          ))}
        </div>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
