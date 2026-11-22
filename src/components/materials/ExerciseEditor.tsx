'use client';

/**
 * 一道生成题的审核/编辑卡片。
 *
 * 四条产品口径：
 * 1. **AI 标识常驻**：`AiDerivedCallout` 不因"已采纳"消失 —— 采纳是"我认可"，
 *    不是"它变成了事实"；
 * 2. **编辑要重新自检**：保存时把改动整体提交给服务端，由 `checkExerciseDraft`
 *    重新判一遍（选项数、正确答案、原文依据），前端不做第二套判断；
 * 3. **依据类失败不可保存**：服务端返回 `PRECONDITION` 时把原话显示出来，
 *    并提示"退役后重新生成"——因为用户改不动"原文里找不到这句话"；
 * 4. **退役要写原因**：这是唯一会把题从练习集里拿走的动作，必须留下理由。
 */

import { useState } from 'react';
import { AiDerivedCallout } from '@/components/materials/AiDerivedCallout';
import { EvidenceQuotePanel } from '@/components/materials/EvidenceQuotePanel';
import { Icon } from '@/components/ui/Icon';
import {
  MATERIAL_EXERCISE_TYPE_LABELS_ZH,
  type MaterialExerciseReviewStatus,
} from '@/lib/constants';
import { retireExerciseAction, reviewExerciseAction } from '@/lib/actions/materialExercises';
import type { ExerciseDto } from '@/lib/queries/materials';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';

const BTN_SECONDARY = `${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`;
const BTN_PRIMARY = `${BTN} border-brand bg-brand text-white hover:bg-blue-700`;
const BTN_OK = `${BTN} border-egGreen/50 bg-egGreen/10 text-egGreen hover:bg-egGreen/20`;
const BTN_DANGER = `${BTN} border-egRed/40 bg-egRed/10 text-egRed hover:bg-egRed/20`;

/** 审核状态徽章配色（只用调色板）。 */
const STATUS_CLASS: Record<MaterialExerciseReviewStatus, string> = {
  draft: 'border-line bg-surfaceAlt text-inkMuted',
  needs_review: 'border-egYellow/50 bg-egYellow/10 text-ink',
  approved: 'border-egGreen/40 bg-egGreen/10 text-egGreen',
  rejected: 'border-egRed/40 bg-egRed/10 text-egRed',
  retired: 'border-line bg-surfaceAlt text-inkMuted',
};

/** 编辑草稿（全部是字符串，提交前再组装成服务端入参）。 */
interface EditDraftState {
  prompt: string;
  explanation: string;
  evidenceQuote: string;
  correctKey: string;
  options: Array<{ key: string; text: string }>;
}

export interface ExerciseEditorProps {
  exercise: ExerciseDto;
  materialId: string;
  /** 选择态（批量操作用）。 */
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** 审核成功后通知父组件（刷新 + 轻提示）。 */
  onReviewed: (message: string) => void;
  disabled?: boolean;
}

export function ExerciseEditor({
  exercise,
  materialId,
  selected,
  onToggleSelect,
  onReviewed,
  disabled = false,
}: ExerciseEditorProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [retireReason, setRetireReason] = useState('');
  const [draft, setDraft] = useState<EditDraftState>({
    prompt: exercise.prompt,
    explanation: exercise.explanation ?? '',
    evidenceQuote: exercise.evidenceQuote,
    correctKey: exercise.correctKey ?? '',
    options: exercise.options.map((option) => ({ ...option })),
  });

  const retired = exercise.retiredAt !== null || exercise.reviewStatus === 'retired';

  const startEditing = (): void => {
    setDraft({
      prompt: exercise.prompt,
      explanation: exercise.explanation ?? '',
      evidenceQuote: exercise.evidenceQuote,
      correctKey: exercise.correctKey ?? '',
      options: exercise.options.map((option) => ({ ...option })),
    });
    setEditing(true);
    setError(null);
  };

  const submit = async (
    reviewStatus: MaterialExerciseReviewStatus,
    withEdits: boolean,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await reviewExerciseAction({
        exerciseId: exercise.id,
        reviewStatus,
        ...(withEdits
          ? {
              edits: {
                prompt: draft.prompt,
                options: draft.options,
                correctKey: draft.correctKey,
                explanation: draft.explanation,
                evidenceQuote: draft.evidenceQuote,
              },
            }
          : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
      onReviewed(
        withEdits
          ? '已保存修改并重新核验原文依据'
          : `已更新为「${result.data.reviewStatus === 'approved' ? '已审核通过' : result.data.reviewStatus === 'rejected' ? '已拒绝' : '待复核'}」`,
      );
    } finally {
      setBusy(false);
    }
  };

  const retire = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await retireExerciseAction({
        exerciseId: exercise.id,
        reason: retireReason.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRetiring(false);
      onReviewed('这道题已退役（历史作答保留）');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className={[
        'rounded-lg border p-3',
        selected ? 'border-brand bg-brand/5' : 'border-line bg-surface',
      ].join(' ')}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(exercise.id)}
            aria-label="选择这道题"
            disabled={retired}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-line"
          />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-ink">
                {MATERIAL_EXERCISE_TYPE_LABELS_ZH[exercise.type]}
              </span>
              <span
                className={`rounded border px-1 py-0.5 text-[10px] ${STATUS_CLASS[exercise.reviewStatus]}`}
              >
                {exercise.reviewStatusLabel}
              </span>
              {exercise.difficultyEstimate && (
                <span className="rounded border border-line bg-surfaceAlt px-1 py-0.5 text-[10px] text-inkMuted">
                  AI 难度估计 {exercise.difficultyEstimate}
                </span>
              )}
              {exercise.subskill && (
                <span className="rounded border border-line bg-surfaceAlt px-1 py-0.5 text-[10px] text-inkMuted">
                  {exercise.subskill}
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[10px] text-inkMuted">
              {exercise.page !== null ? `第 ${exercise.page} 页 · ` : ''}
              {exercise.paragraphIndex !== null ? `第 ${exercise.paragraphIndex} 段 · ` : ''}
              已作答 {exercise.attemptCount} 次
              {exercise.lastAttemptCorrect === null
                ? ''
                : exercise.lastAttemptCorrect
                  ? ' · 最近一次正确'
                  : ' · 最近一次错误'}
            </p>
          </div>
        </div>
        <AiDerivedCallout />
      </header>

      {/* 题干 */}
      {editing ? (
        <div className="mt-2 space-y-1.5">
          <label className="block text-[10px] text-inkMuted">
            题干
            <textarea
              value={draft.prompt}
              onChange={(event) => setDraft((prev) => ({ ...prev, prompt: event.target.value }))}
              rows={2}
              className="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-ink"
            />
          </label>

          <div className="space-y-1">
            <p className="text-[10px] text-inkMuted">选项（正确答案打勾）</p>
            {draft.options.map((option, index) => (
              <div key={`${option.key}-${index}`} className="flex items-center gap-1">
                <input
                  value={option.key}
                  onChange={(event) =>
                    setDraft((prev) => {
                      const next = prev.options.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, key: event.target.value } : item,
                      );
                      return { ...prev, options: next };
                    })
                  }
                  className="w-10 shrink-0 rounded border border-line bg-surface px-1 py-1 text-center text-[11px] text-ink"
                />
                <input
                  value={option.text}
                  onChange={(event) =>
                    setDraft((prev) => {
                      const next = prev.options.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, text: event.target.value } : item,
                      );
                      return { ...prev, options: next };
                    })
                  }
                  className="min-w-0 flex-1 rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-ink"
                />
                <input
                  type="radio"
                  name={`correct-${exercise.id}`}
                  checked={draft.correctKey === option.key}
                  onChange={() =>
                    setDraft((prev) => ({ ...prev, correctKey: option.key }))
                  }
                  aria-label={`把 ${option.key} 设为正确答案`}
                  className="h-3.5 w-3.5 shrink-0"
                />
              </div>
            ))}
          </div>

          <label className="block text-[10px] text-inkMuted">
            解析
            <textarea
              value={draft.explanation}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, explanation: event.target.value }))
              }
              rows={2}
              className="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-ink"
            />
          </label>

          <label className="block text-[10px] text-inkMuted">
            原文依据（必须逐字来自下方原文，否则保存会被拒）
            <textarea
              value={draft.evidenceQuote}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, evidenceQuote: event.target.value }))
              }
              rows={2}
              className="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-ink"
            />
          </label>
        </div>
      ) : (
        <div className="mt-2">
          <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink">
            {exercise.prompt}
          </p>
          <ol className="mt-1 space-y-0.5">
            {exercise.options.map((option) => (
              <li key={option.key} className="flex gap-1.5 text-[11px] leading-relaxed">
                <span className="w-4 shrink-0 text-inkMuted">{option.key}</span>
                <span className="min-w-0 flex-1 break-words text-ink">{option.text}</span>
                {exercise.correctKey === option.key && (
                  <span className="shrink-0 rounded border border-egGreen/40 bg-egGreen/10 px-1 text-[10px] text-egGreen">
                    答案
                  </span>
                )}
              </li>
            ))}
          </ol>
          {exercise.explanation && (
            <p className="mt-1 text-[11px] leading-relaxed text-inkMuted">
              解析：{exercise.explanation}
            </p>
          )}
        </div>
      )}

      <div className="mt-2">
        <EvidenceQuotePanel
          quote={exercise.evidenceQuote}
          chunkId={exercise.chunkId}
          materialId={materialId}
          consistencyCheck={exercise.consistencyCheck}
          consistencyNote={exercise.consistencyNote}
        />
      </div>

      {exercise.retireReason && (
        <p className="mt-1.5 text-[11px] text-inkMuted">退役原因：{exercise.retireReason}</p>
      )}

      {error && <p className="mt-1.5 text-[11px] text-egRed">{error}</p>}

      {retiring && (
        <div className="mt-2 rounded-md border border-egRed/40 bg-egRed/5 p-2">
          <p className="text-[10px] text-ink">
            退役后这道题不再提供作答（历史作答与统计保留）。请写明原因，至少 4 个字。
          </p>
          <input
            value={retireReason}
            onChange={(event) => setRetireReason(event.target.value)}
            placeholder="例如：选项与原文不符"
            className="mt-1 w-full rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-ink"
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => void retire()}
              disabled={busy || retireReason.trim().length < 4}
              className={BTN_DANGER}
            >
              确认退役
            </button>
            <button
              type="button"
              onClick={() => setRetiring(false)}
              disabled={busy}
              className={BTN_SECONDARY}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <footer className="mt-2 flex flex-wrap items-center gap-1.5">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => void submit('approved', true)}
              disabled={busy || disabled}
              className={BTN_PRIMARY}
            >
              <Icon name="check" size={11} />
              保存修改并采纳
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className={BTN_SECONDARY}
            >
              放弃修改
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void submit('approved', false)}
              disabled={busy || disabled || retired || exercise.reviewStatus === 'approved'}
              className={BTN_OK}
            >
              <Icon name="check" size={11} />
              采纳
            </button>
            <button
              type="button"
              onClick={() => void submit('needs_review', false)}
              disabled={busy || disabled || retired || exercise.reviewStatus === 'needs_review'}
              className={BTN_SECONDARY}
            >
              <Icon name="flag" size={11} />
              标为待复核
            </button>
            <button
              type="button"
              onClick={() => void submit('rejected', false)}
              disabled={busy || disabled || retired || exercise.reviewStatus === 'rejected'}
              className={BTN_DANGER}
            >
              拒绝
            </button>
            <button
              type="button"
              onClick={startEditing}
              disabled={busy || disabled || retired}
              className={BTN_SECONDARY}
            >
              修改
            </button>
            <span className="mx-1 h-4 w-px bg-line" />
            <button
              type="button"
              onClick={() => setRetiring(true)}
              disabled={busy || disabled || retired}
              className={BTN_SECONDARY}
            >
              <Icon name="trash" size={11} />
              退役
            </button>
          </>
        )}
      </footer>
    </article>
  );
}
