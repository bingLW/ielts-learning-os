'use client';

/**
 * 一条词汇候选（T12）。
 *
 * 设计取舍：
 * 1. **上下文句永远显示，且把词高亮出来**：脱离语境的词表没法审 —— 用户要看的是
 *    "这个词在这句话里是不是这个意思"，而不是孤立词条。
 * 2. **编辑是「展开」而不是常驻输入框**：90% 的候选只需要点采纳，常驻三个输入框
 *    会让列表变成一张表格状的噪声；展开后仍然只有词条/词性/释义三个字段。
 * 3. **「不进词库」= 跳过**：它同时把 `reviewStatus` 置 `rejected` 且 `syncStatus`
 *    置 `skipped`（由 action 保证），所以这里只需要一个按钮，没有"拒绝但不跳过"。
 * 4. **同步过的词只读**：已经进主库的候选再改词条，等于让候选与词库词条分叉，
 *    这里直接禁用编辑入口（要改去词库页改）。
 */

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { reviewVocabularyCandidateAction, skipVocabularyCandidateAction } from '@/lib/actions/materialVocabulary';
import type { VocabCandidateDto } from '@/lib/queries/materials';
import { SyncStatusCell } from './SyncStatusCell';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';

const BTN_SECONDARY = `${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`;
const BTN_PRIMARY = `${BTN} border-brand bg-brand text-white hover:bg-blue-700`;
const BTN_ACCEPT = `${BTN} border-egGreen/50 bg-egGreen/10 text-egGreen hover:bg-egGreen/20`;
const BTN_DANGER = `${BTN} border-egRed/40 bg-egRed/10 text-egRed hover:bg-egRed/20`;

/** 输入框样式（与练习编辑器的字段保持一致）。 */
const INPUT =
  'w-full rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/40';

export interface CandidateRowProps {
  candidate: VocabCandidateDto;
  materialId: string;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** 任意裁决成功后的回调（父组件负责提示与刷新）。 */
  onReviewed: (message: string) => void;
  disabled: boolean;
}

/**
 * 把上下文句切成「前 / 命中词 / 后」三段（忽略大小写定位）。
 *
 * 找不到就整句返回 —— 绝不猜位置：高亮画错比不高亮更误导。
 *
 * @param sentence 上下文句
 * @param word 原文写法（`surfaceForm`）
 */
export function splitContext(
  sentence: string,
  word: string,
): { before: string; hit: string; after: string } {
  const needle = (word ?? '').trim();
  if (needle.length === 0) return { before: sentence, hit: '', after: '' };
  const at = sentence.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return { before: sentence, hit: '', after: '' };
  return {
    before: sentence.slice(0, at),
    hit: sentence.slice(at, at + needle.length),
    after: sentence.slice(at + needle.length),
  };
}

export function CandidateRow({
  candidate,
  materialId,
  selected,
  onToggleSelect,
  onReviewed,
  disabled,
}: CandidateRowProps) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [lemma, setLemma] = useState(candidate.lemma);
  const [pos, setPos] = useState(candidate.pos);
  const [definitionZh, setDefinitionZh] = useState(candidate.definitionZh ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const locked = candidate.syncStatus === 'synced';
  const context = splitContext(candidate.contextSentence, candidate.surfaceForm);

  const run = async (task: () => Promise<{ ok: boolean; error?: string }>, message: string): Promise<void> => {
    setBusy(true);
    setFieldError(null);
    try {
      const result = await task();
      if (!result.ok) {
        setFieldError(result.error ?? '操作失败');
        return;
      }
      onReviewed(message);
    } finally {
      setBusy(false);
    }
  };

  const accept = (): void => {
    void run(
      () => reviewVocabularyCandidateAction({ id: candidate.id, reviewStatus: 'accepted' }),
      `已采纳「${candidate.lemma}」`,
    );
  };

  const reject = (): void => {
    void run(
      () => reviewVocabularyCandidateAction({ id: candidate.id, reviewStatus: 'rejected' }),
      `已拒绝「${candidate.lemma}」`,
    );
  };

  const editAndAccept = (): void => {
    void run(
      () =>
        reviewVocabularyCandidateAction({
          id: candidate.id,
          reviewStatus: 'edited',
          lemma,
          pos,
          definitionZh,
        }),
      `已修改并采纳「${lemma.trim() || candidate.lemma}」`,
    );
  };

  const skip = (): void => {
    void run(
      () => skipVocabularyCandidateAction({ id: candidate.id }),
      `已跳过「${candidate.lemma}」（不进词库）`,
    );
  };

  const reviewTone =
    candidate.reviewStatus === 'accepted' || candidate.reviewStatus === 'edited'
      ? 'border-egGreen/40 bg-egGreen/10 text-egGreen'
      : candidate.reviewStatus === 'rejected'
        ? 'border-egRed/40 bg-egRed/10 text-egRed'
        : 'border-egYellow/50 bg-egYellow/10 text-egYellow';

  return (
    <article
      id={`candidate-${candidate.id}`}
      className="scroll-mt-20 rounded-lg border border-line bg-surface p-2.5"
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          aria-label={`选择「${candidate.lemma}」`}
          checked={selected}
          disabled={disabled || busy || candidate.reviewStatus !== 'draft'}
          onChange={() => onToggleSelect(candidate.id)}
          className="mt-1 h-3.5 w-3.5 shrink-0 accent-brand"
        />

        <div className="min-w-0 flex-1 space-y-1">
          {/* ── 词条 + 状态 ───────────────────────────────── */}
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-sm font-semibold text-ink">{candidate.lemma}</span>
            {candidate.pos && (
              <span className="font-mono text-[10px] text-inkMuted">{candidate.pos}</span>
            )}
            {candidate.surfaceForm.toLowerCase() !== candidate.normalizedLemma && (
              <span className="text-[10px] text-inkMuted">（原文：{candidate.surfaceForm}）</span>
            )}
            <span className={`rounded border px-1 py-0.5 text-[10px] ${reviewTone}`}>
              {candidate.reviewStatusLabel}
            </span>
            <span className="text-[10px] text-inkMuted">
              第 {candidate.chunkSeq ?? '?'} 段
              {candidate.page !== null ? ` · 第 ${candidate.page} 页` : ''}
              {candidate.occurrenceCount > 1 ? ` · 出现 ${candidate.occurrenceCount} 次` : ''}
            </span>
          </div>

          {/* ── 上下文（高亮命中词） ────────────────────────── */}
          <p className="rounded-md bg-surfaceAlt px-2 py-1 text-[11px] leading-relaxed text-ink">
            {context.before}
            {context.hit && (
              <mark className="rounded-sm bg-egYellow/30 px-0.5 text-ink">{context.hit}</mark>
            )}
            {context.after}
          </p>

          {/* ── 释义（AI 候选 vs 主库） ─────────────────────── */}
          <div className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
            <span className="text-inkMuted">候选释义：</span>
            {candidate.definitionZh ? (
              <span className="text-ink">{candidate.definitionZh}</span>
            ) : (
              <span className="text-inkMuted">（AI 没有给出释义）</span>
            )}
            {candidate.definitionEn && (
              <span className="text-[10px] text-inkMuted">· {candidate.definitionEn}</span>
            )}
          </div>

          {candidate.collocations.length > 0 && (
            <p className="text-[10px] leading-relaxed text-inkMuted">
              搭配：{candidate.collocations.join('、')}
            </p>
          )}

          <SyncStatusCell
            status={candidate.syncStatus}
            statusLabel={candidate.syncStatusLabel}
            error={candidate.syncError}
            existsInLibrary={candidate.existsInLibrary}
            libraryDefinitionZh={candidate.libraryDefinitionZh}
          />

          {/* ── 编辑区（展开） ─────────────────────────────── */}
          {editing && (
            <div className="space-y-1.5 rounded-md border border-line bg-surfaceAlt p-2">
              <label className="block text-[10px] text-inkMuted">
                词条（必填）
                <input
                  className={`${INPUT} mt-0.5`}
                  value={lemma}
                  maxLength={60}
                  onChange={(event) => setLemma(event.target.value)}
                />
              </label>
              <label className="block text-[10px] text-inkMuted">
                词性
                <input
                  className={`${INPUT} mt-0.5`}
                  value={pos}
                  maxLength={20}
                  placeholder="如 n / v / adj（留空 = 未知）"
                  onChange={(event) => setPos(event.target.value)}
                />
              </label>
              <label className="block text-[10px] text-inkMuted">
                中文释义
                <input
                  className={`${INPUT} mt-0.5`}
                  value={definitionZh}
                  maxLength={200}
                  onChange={(event) => setDefinitionZh(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={editAndAccept}
                  disabled={busy || lemma.trim().length === 0}
                  className={BTN_ACCEPT}
                >
                  <Icon name="check" size={11} />
                  保存并采纳
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  disabled={busy}
                  className={BTN_SECONDARY}
                >
                  收起
                </button>
                <span className="text-[10px] text-inkMuted">
                  改词条会重算归一化键；同一句原文下重复会被拒绝
                </span>
              </div>
            </div>
          )}

          {fieldError && <p className="text-[10px] text-egRed">{fieldError}</p>}

          {/* ── 操作 ─────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {candidate.reviewStatus === 'draft' && (
              <>
                <button
                  type="button"
                  onClick={accept}
                  disabled={busy || disabled}
                  className={BTN_PRIMARY}
                >
                  <Icon name="check" size={11} />
                  采纳
                </button>
                <button
                  type="button"
                  onClick={() => setEditing((prev) => !prev)}
                  disabled={busy || disabled || locked}
                  className={BTN_SECONDARY}
                >
                  修改后采纳
                </button>
                <button
                  type="button"
                  onClick={reject}
                  disabled={busy || disabled}
                  className={BTN_DANGER}
                >
                  拒绝
                </button>
              </>
            )}
            {candidate.reviewStatus !== 'draft' && !locked && (
              <button
                type="button"
                onClick={skip}
                disabled={busy || disabled}
                className={BTN_SECONDARY}
                title="标记为不进入词库（同时把审核状态置为已拒绝）"
              >
                不进词库
              </button>
            )}
            {locked && (
              <span className="text-[10px] text-inkMuted">
                已同步进词库，改内容请到词库页操作（这里只保留来源记录）
              </span>
            )}
            {busy && <span className="text-[10px] text-inkMuted">处理中…</span>}
          </div>

          <p className="text-[10px] text-inkMuted">
            归一化键：{candidate.normalizedLemma} · 义项 {candidate.senseKey} ·
            <a
              href={`/materials/${materialId}/read?mode=vocab_assist&chunk=${candidate.chunkId}`}
              className="ml-1 text-brand underline-offset-2 hover:underline"
            >
              回到原文位置
            </a>
          </p>
        </div>
      </div>
    </article>
  );
}
