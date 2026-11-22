'use client';

/**
 * 练习生成页的交互容器（生成按钮 + 批量栏 + 题目列表）。
 *
 * 为什么把"生成"也放在这里：生成不是一个独立页面，而是**一次状态转移**
 * （`review_required → generating`）。点完之后材料进入 `generating`，
 * 由处理页的 tick 循环推进 —— 所以这里只负责发起，然后跳到处理页看进度，
 * 不在本页自己轮询（避免同一材料出现两套轮询互相抢 tick）。
 *
 * 选择集只在前端：勾选不是持久状态，刷新后归零。
 */

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import {
  bulkReviewExercisesAction,
  startExerciseGenerationAction,
} from '@/lib/actions/materialExercises';
import type { MaterialStatus } from '@/lib/constants';
import type {
  ExerciseSetCardDto,
  ExerciseSetDetailDto,
  MaterialExerciseReadinessDto,
} from '@/lib/queries/materials';
import { ExerciseEditor } from './ExerciseEditor';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';

const BTN_SECONDARY = `${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`;
const BTN_PRIMARY = `${BTN} border-brand bg-brand text-white hover:bg-blue-700`;
const BTN_DANGER = `${BTN} border-egRed/40 bg-egRed/10 text-egRed hover:bg-egRed/20`;

/** 与 `exerciseBulkReviewSchema` 的 `max(200)` 保持一致。 */
const BULK_MAX = 200;

export interface ExerciseBuilderBodyProps {
  materialId: string;
  materialStatus: MaterialStatus;
  readiness: MaterialExerciseReadinessDto;
  /** 该材料的所有练习集（活动集排在第一个）。 */
  sets: ExerciseSetCardDto[];
  /** 活动练习集的详情（含答案，审核页可以看）。 */
  activeSet: ExerciseSetDetailDto | null;
}

export function ExerciseBuilderBody({
  materialId,
  materialStatus,
  readiness,
  sets,
  activeSet,
}: ExerciseBuilderBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const reviewable = useMemo(
    () =>
      (activeSet?.exercises ?? []).filter(
        (exercise) => exercise.retiredAt === null && exercise.reviewStatus !== 'retired',
      ),
    [activeSet],
  );
  const pending = useMemo(
    () =>
      reviewable.filter(
        (exercise) =>
          exercise.reviewStatus === 'draft' || exercise.reviewStatus === 'needs_review',
      ),
    [reviewable],
  );
  const allPendingSelected = pending.length > 0 && selected.length === pending.length;

  const finish = (message: string): void => {
    show(message, 'success');
    setSelected([]);
    router.refresh();
  };

  const toggleSelect = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const toggleAll = (): void => {
    setSelected(allPendingSelected ? [] : pending.slice(0, BULK_MAX).map((item) => item.id));
  };

  const generate = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await startExerciseGenerationAction({ materialId });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      // 生成靠处理页的 tick 推进：跳过去让已有的轮询接手
      router.push(`/materials/${materialId}/processing`);
    } finally {
      setBusy(false);
    }
  };

  const bulk = async (reviewStatus: 'approved' | 'rejected'): Promise<void> => {
    if (selected.length === 0) {
      show('请先勾选要处理的题目', 'error');
      return;
    }
    if (selected.length > BULK_MAX) {
      show(`一次最多处理 ${BULK_MAX} 道，请分批处理`, 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await bulkReviewExercisesAction({
        materialId,
        ids: selected,
        reviewStatus,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      finish(
        result.data.updated > 0
          ? `已${reviewStatus === 'approved' ? '采纳' : '拒绝'} ${result.data.updated} 道题`
          : '这些题已被处理过，没有需要更新的行',
      );
    } finally {
      setBusy(false);
    }
  };

  const canGenerate = materialStatus === 'review_required' && readiness.canGenerate;

  return (
    <div className="space-y-3">
      {/* ── 出题依据与生成入口 ───────────────────────────────── */}
      <div className="rounded-lg border border-line bg-surface p-2.5">
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink">
          <Icon name="bulb" size={12} />
          <span className="font-semibold">出题依据</span>
          <span className="text-inkMuted">
            已采纳 {readiness.acceptedAnchors} 条分析结果 · 现有题目 {readiness.exerciseCount}/
            {readiness.maxExercises} 道 · 已通过 {readiness.approvedCount} 道
          </span>
        </p>
        {readiness.reasonZh && (
          <p className="mt-1 text-[11px] leading-relaxed text-inkMuted">{readiness.reasonZh}</p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy || !canGenerate}
            className={BTN_PRIMARY}
          >
            <Icon name="play" size={11} />
            {readiness.exerciseCount > 0 ? '继续生成练习' : '生成练习'}
          </button>
          {activeSet && (
            <a
              href={`/exercises/${activeSet.set.id}`}
              className={BTN_SECONDARY}
            >
              <Icon name="play" size={11} />
              去作答（{activeSet.set.counts.approved + activeSet.set.counts.draft + activeSet.set.counts.needsReview} 道可练）
            </a>
          )}
          {materialStatus === 'generating' && (
            <span className="text-[11px] text-inkMuted">
              正在生成，进度见
              <a
                href={`/materials/${materialId}/processing`}
                className="ml-1 text-brand underline-offset-2 hover:underline"
              >
                处理页
              </a>
            </span>
          )}
          {materialStatus !== 'review_required' && materialStatus !== 'generating' && (
            <span className="text-[11px] text-inkMuted">
              当前状态（{materialStatus}）下不能发起生成：请先让分析完成并停在「待你审核」。
            </span>
          )}
          {busy && <span className="text-[11px] text-inkMuted">处理中…</span>}
        </div>
      </div>

      {/* ── 批量栏 ───────────────────────────────────────────── */}
      {activeSet && reviewable.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface p-2">
          <button
            type="button"
            onClick={toggleAll}
            disabled={busy || pending.length === 0}
            className={BTN_SECONDARY}
          >
            {allPendingSelected ? '取消全选' : `全选待处理（${pending.length}）`}
          </button>
          <button
            type="button"
            onClick={() => void bulk('approved')}
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
          <span className="text-[11px] text-inkMuted">
            待处理 {activeSet.set.counts.draft + activeSet.set.counts.needsReview} 道 ·
            已通过 {activeSet.set.counts.approved} 道 ·
            已拒绝 {activeSet.set.counts.rejected} 道 ·
            已退役 {activeSet.set.counts.retired} 道
          </span>
        </div>
      )}

      {/* ── 练习集列表 ───────────────────────────────────────── */}
      {sets.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-surface p-4 text-xs leading-relaxed text-inkMuted">
          这份材料还没有练习题。先在「AI 分析」页采纳至少一条结果，再回到这里点「生成练习」。
        </p>
      ) : (
        <div className="space-y-1.5">
          {sets.map((set) => (
            <div
              key={set.id}
              className="flex flex-wrap items-center justify-between gap-1.5 rounded-md border border-line bg-surfaceAlt px-2 py-1.5 text-[11px]"
            >
              <span className="flex flex-wrap items-center gap-1.5 text-ink">
                <span className="font-semibold">{set.title}</span>
                <span className="text-inkMuted">
                  {set.targetSkillLabel} · 约 {set.estimatedMinutes} 分钟 · 共 {set.counts.total} 道
                </span>
                {set.isActive && (
                  <span className="rounded border border-brand/40 bg-brand/10 px-1 text-[10px] text-brand">
                    当前使用
                  </span>
                )}
                {set.hasApprovedOnly && (
                  <span className="rounded border border-egGreen/40 bg-egGreen/10 px-1 text-[10px] text-egGreen">
                    全部已审核
                  </span>
                )}
              </span>
              <a
                href={`/exercises/${set.id}`}
                className="text-brand underline-offset-2 hover:underline"
              >
                打开练习
              </a>
            </div>
          ))}
        </div>
      )}

      {/* ── 题目列表（活动集） ───────────────────────────────── */}
      {activeSet && reviewable.length > 0 ? (
        <div className="space-y-2">
          {reviewable.map((exercise) => (
            <ExerciseEditor
              key={exercise.id}
              exercise={exercise}
              materialId={materialId}
              selected={selected.includes(exercise.id)}
              onToggleSelect={toggleSelect}
              onReviewed={finish}
              disabled={busy}
            />
          ))}
        </div>
      ) : activeSet ? (
        <p className="rounded-lg border border-dashed border-line bg-surface p-4 text-xs leading-relaxed text-inkMuted">
          这个练习集里的题都已退役。可以再点「生成练习」补齐（已退役的段落会重新出题）。
        </p>
      ) : null}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
