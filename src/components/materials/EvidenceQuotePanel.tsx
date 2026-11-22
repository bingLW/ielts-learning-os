/**
 * 原文依据面板（练习编辑器与作答结果共用）。
 *
 * 三条产品口径：
 * 1. **依据永远显示**：一道题的 `evidenceQuote` 是它能存在的原因。哪怕引用为空
 *    （理论上不会入库）也要显式提示「缺依据」，而不是渲染一片空白；
 * 2. **一致性自检只做"能证明才标绿"**：`unchecked` 不是错误，文案必须说清
 *    「无法自动核对，需要人工判断」，否则用户会把灰色当成"题坏了"；
 * 3. **能定位到原文**：给出 chunk 链接，让人可以立刻回原文核对（这是唯一可信的复核方式）。
 */

import { Icon } from '@/components/ui/Icon';
import type { MaterialConsistencyStatus } from '@/lib/constants';

/** 一致性徽章的配色与文案（`pass` 才绿，其余一律中性色）。 */
const CONSISTENCY_VIEW: Record<
  MaterialConsistencyStatus,
  { label: string; className: string }
> = {
  pass: { label: '依据可核对', className: 'border-egGreen/40 bg-egGreen/10 text-egGreen' },
  unchecked: { label: '依据未自动核对', className: 'border-line bg-surfaceAlt text-inkMuted' },
  fail: { label: '依据不一致', className: 'border-egRed/40 bg-egRed/10 text-egRed' },
};

export interface EvidenceQuotePanelProps {
  /** 原文依据（逐字来自材料）。 */
  quote: string;
  /** 依据所属 chunk（有值时渲染"在原文里定位"）。 */
  chunkId: string | null;
  /** 材料 id（定位链接用；缺省不渲染链接）。 */
  materialId?: string | null;
  consistencyCheck: MaterialConsistencyStatus;
  consistencyNote?: string | null;
  /** 标题（默认「原文依据」）。 */
  title?: string;
}

export function EvidenceQuotePanel({
  quote,
  chunkId,
  materialId,
  consistencyCheck,
  consistencyNote,
  title = '原文依据',
}: EvidenceQuotePanelProps) {
  const badge = CONSISTENCY_VIEW[consistencyCheck];
  const hasQuote = quote.trim().length > 0;

  return (
    <div className="rounded-md border border-line bg-surfaceAlt p-2">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <p className="flex items-center gap-1 text-[10px] font-semibold text-inkMuted">
          <Icon name="quote" size={11} />
          {title}
        </p>
        <span className={`rounded border px-1 py-0.5 text-[10px] ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      {hasQuote ? (
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink">
          {quote}
        </p>
      ) : (
        <p className="mt-0.5 text-[11px] text-egRed">
          这道题没有可核验的原文引用，不能用来练习（请退役并重新生成）
        </p>
      )}

      {consistencyNote && (
        <p className="mt-1 text-[10px] leading-relaxed text-inkMuted">{consistencyNote}</p>
      )}

      {chunkId && materialId && (
        <a
          href={`/materials/${materialId}/read?chunk=${chunkId}`}
          className="mt-1 inline-flex items-center gap-1 text-[10px] text-brand underline-offset-2 hover:underline"
        >
          <Icon name="search" size={10} />
          在原文里定位
        </a>
      )}
    </div>
  );
}
