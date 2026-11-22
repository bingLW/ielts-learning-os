'use client';

/**
 * 一条 AI 提取结果的审核卡片。
 *
 * 三条产品口径：
 * 1. **原文引用必须显示**：`sourceQuote` 是这条结论存在的唯一理由，
 *    没有它（理论上不会发生）也要显式提示「缺引用」，而不是静默隐藏；
 * 2. **编辑只改 `editedPayloadJson`**：AI 原始 `payloadJson` 永不覆盖（可追溯）；
 * 3. **AI 标识常驻**：卡片右上角固定 `AiDerivedCallout`，不因已采纳而消失 ——
 *    "采纳"是"我认可"，不是"它变成了事实"。
 */

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  MATERIAL_EXTRACTION_KIND_LABELS_ZH,
  MATERIAL_REVIEW_STATUS_LABELS_ZH,
  type MaterialReviewStatus,
} from '@/lib/constants';
import type { ExtractionCardDto } from '@/lib/queries/materials';
import { reviewExtractionResultAction } from '@/lib/actions/materialAnalysis';
import { AiDerivedCallout } from './AiDerivedCallout';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';

/** payload 字段的中文标签（缺省显示原始 key，便于排查新增字段）。 */
const PAYLOAD_LABELS_ZH: Record<string, string> = {
  lemma: '词形',
  pos: '词性',
  definition_zh: '中文释义',
  collocations: '常见搭配',
  skeleton: '句子骨架',
  grammar_points: '语法点',
  gist: '段落主旨',
  summary_zh: '摘要',
  topics: '主题',
  source_chunk_seq: '来源段落',
  source_quote: '原文引用',
};

/** 状态徽章的配色（只用调色板，不用任意色值）。 */
const STATUS_CLASS: Record<MaterialReviewStatus, string> = {
  draft: 'border-line bg-surfaceAlt text-inkMuted',
  accepted: 'border-egGreen/40 bg-egGreen/10 text-egGreen',
  edited: 'border-brand/40 bg-brand/10 text-brand',
  rejected: 'border-egRed/40 bg-egRed/10 text-egRed',
};

export interface ExtractionCardProps {
  card: ExtractionCardDto;
  /** 材料 id（"定位到原文"链接用）。 */
  materialId: string;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** 审核成功后通知父组件（刷新 + 轻提示）。 */
  onReviewed: (message: string) => void;
  /** 材料已定稿（ready / partial 之外）时禁用按钮。 */
  disabled?: boolean;
}

/** 把任意 payload 值渲染成一行可读文本。 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ExtractionCard({
  card,
  materialId,
  selected,
  onToggleSelect,
  onReviewed,
  disabled = false,
}: ExtractionCardProps) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 编辑草稿：以「已展示的 payload」（edited 优先）为初值
  const [draft, setDraft] = useState<Record<string, string>>({});

  const shown = card.editedPayload ?? card.payload;
  const entries = Object.entries(shown);
  const editableKeys = entries
    .filter(([, value]) => typeof value === 'string')
    .map(([key]) => key);

  const startEditing = (): void => {
    const next: Record<string, string> = {};
    for (const key of editableKeys) {
      const value = shown[key];
      next[key] = typeof value === 'string' ? value : '';
    }
    setDraft(next);
    setEditing(true);
    setError(null);
  };

  const submit = async (
    reviewStatus: MaterialReviewStatus,
    editedPayload?: Record<string, unknown>,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await reviewExtractionResultAction({
        id: card.id,
        reviewStatus,
        ...(editedPayload ? { editedPayload } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
      onReviewed(`已更新：${MATERIAL_REVIEW_STATUS_LABELS_ZH[reviewStatus]}`);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (): Promise<void> => {
    // 只把字符串字段的改动合并回去，非字符串字段（数组/数字）保持 AI 原值
    const merged: Record<string, unknown> = { ...shown };
    for (const key of editableKeys) {
      merged[key] = draft[key] ?? '';
    }
    await submit('edited', merged);
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
            onChange={() => onToggleSelect(card.id)}
            aria-label="选择这条结果"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-line"
          />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-ink">
                {MATERIAL_EXTRACTION_KIND_LABELS_ZH[card.kind]}
              </span>
              <span
                className={`rounded border px-1 py-0.5 text-[10px] ${STATUS_CLASS[card.reviewStatus]}`}
              >
                {MATERIAL_REVIEW_STATUS_LABELS_ZH[card.reviewStatus]}
              </span>
              {!card.sourceVerified && (
                <span className="rounded border border-egRed/40 bg-egRed/10 px-1 py-0.5 text-[10px] text-egRed">
                  缺原文依据
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[10px] text-inkMuted">
              {card.page !== null ? `第 ${card.page} 页 · ` : ''}
              {card.paragraphIndex !== null ? `第 ${card.paragraphIndex} 段 · ` : ''}
              {new Date(card.createdAt).toLocaleString('zh-CN')}
            </p>
          </div>
        </div>
        <AiDerivedCallout />
      </header>

      {/* 结构化负载 */}
      <dl className="mt-2 space-y-0.5">
        {entries.length === 0 && (
          <p className="text-[11px] text-inkMuted">这条结果没有可展示的字段。</p>
        )}
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2 text-[11px] leading-relaxed">
            <dt className="w-20 shrink-0 text-inkMuted">{PAYLOAD_LABELS_ZH[key] ?? key}</dt>
            {editing && editableKeys.includes(key) ? (
              <dd className="min-w-0 flex-1">
                <input
                  value={draft[key] ?? ''}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, [key]: event.target.value }))
                  }
                  className="w-full rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-ink"
                />
              </dd>
            ) : (
              <dd className="min-w-0 flex-1 break-words text-ink">{renderValue(value)}</dd>
            )}
          </div>
        ))}
      </dl>

      {/* 原文依据 */}
      <div className="mt-2 rounded-md border border-line bg-surfaceAlt p-2">
        <p className="flex items-center gap-1 text-[10px] font-semibold text-inkMuted">
          <Icon name="quote" size={11} />
          原文依据
        </p>
        {card.sourceQuote.trim().length > 0 ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink">
            {card.sourceQuote}
          </p>
        ) : (
          <p className="mt-0.5 text-[11px] text-egRed">这条结果没有可核验的原文引用</p>
        )}
        {card.chunkId && (
          <a
            href={`/materials/${materialId}/read?chunk=${card.chunkId}`}
            className="mt-1 inline-flex items-center gap-1 text-[10px] text-brand underline-offset-2 hover:underline"
          >
            <Icon name="search" size={10} />
            在原文里定位
          </a>
        )}
      </div>

      {error && <p className="mt-1.5 text-[11px] text-egRed">{error}</p>}

      <footer className="mt-2 flex flex-wrap items-center gap-1.5">
        {editing ? (
          <>
            <button
              type="button"
              onClick={saveEdit}
              disabled={busy || disabled}
              className={`${BTN} border-brand bg-brand text-white hover:bg-blue-700`}
            >
              <Icon name="check" size={11} />
              保存修改
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className={`${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`}
            >
              放弃修改
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void submit('accepted')}
              disabled={busy || disabled || card.reviewStatus === 'accepted'}
              className={`${BTN} border-egGreen/50 bg-egGreen/10 text-egGreen hover:bg-egGreen/20`}
            >
              <Icon name="check" size={11} />
              采纳
            </button>
            <button
              type="button"
              onClick={startEditing}
              disabled={busy || disabled}
              className={`${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`}
            >
              修改后采纳
            </button>
            <button
              type="button"
              onClick={() => void submit('rejected')}
              disabled={busy || disabled || card.reviewStatus === 'rejected'}
              className={`${BTN} border-egRed/40 bg-egRed/10 text-egRed hover:bg-egRed/20`}
            >
              拒绝
            </button>
          </>
        )}
      </footer>
    </article>
  );
}
