'use client';

/**
 * 句子列表（T27）。<768px 卡片列表；软删除需二次确认。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveSentenceAction } from '@/lib/actions/sentences';
import {
  SENTENCE_COMPONENT_LABEL_ZH,
  SENTENCE_COMPONENTS,
} from '@/lib/constants';
import { groupByComponent } from '@/lib/domain/sentence';
import type { SentenceComponent, SentenceRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TagBadge } from '@/components/ui/StatusBadge';

/** 成分 → 语块底色（颜色只做辅助，文字标签才是主信息）。 */
const COMPONENT_BG: Record<SentenceComponent | 'none', string> = {
  S: 'bg-blue-50 border-blue-300 text-blue-900',
  V: 'bg-emerald-50 border-emerald-300 text-emerald-900',
  O: 'bg-amber-50 border-amber-300 text-amber-900',
  C: 'bg-violet-50 border-violet-300 text-violet-900',
  ADVERBIAL: 'bg-slate-50 border-slate-300 text-slate-700',
  none: 'bg-white border-line text-inkMuted',
};

export function SentenceList({
  rows,
  onToast,
}: {
  rows: SentenceRowDto[];
  onToast: (message: string, tone: 'success' | 'error') => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [archiving, setArchiving] = useState<SentenceRowDto | null>(null);

  const confirmArchive = () => {
    if (!archiving) return;
    startTransition(async () => {
      const result = await archiveSentenceAction({ id: archiving.id });
      onToast(result.ok ? '句子已归档' : result.error, result.ok ? 'success' : 'error');
      setArchiving(null);
      if (result.ok) router.refresh();
    });
  };

  return (
    <>
      <ul className="space-y-2">
        {rows.map((row) => {
          const groups = groupByComponent(row.tokens);
          return (
            <li key={row.id} className="rounded-md border border-line bg-white p-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">{row.sentenceEn}</p>
                  {row.sentenceZh && (
                    <p className="text-[11px] text-inkMuted">{row.sentenceZh}</p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {row.isCorrect ? (
                    <TagBadge tone="info">标对</TagBadge>
                  ) : (
                    <TagBadge tone="warn">标错</TagBadge>
                  )}
                  {row.patternLabel && <TagBadge>{row.patternLabel}</TagBadge>}
                  <span className="tabular text-[11px] text-inkMuted">{row.sentenceDate}</span>
                </div>
              </div>

              <div className="mt-1.5 flex flex-wrap gap-1">
                {groups.map((group, index) => (
                  <span
                    key={`${group.text}-${index}`}
                    title={group.component ? SENTENCE_COMPONENT_LABEL_ZH[group.component] : '未标注成分'}
                    className={[
                      'rounded border px-1.5 py-0.5 text-[11px]',
                      COMPONENT_BG[group.component ?? 'none'],
                    ].join(' ')}
                  >
                    {group.text}
                    <span className="ml-1 text-[10px] opacity-80">
                      {group.component
                        ? SENTENCE_COMPONENT_LABEL_ZH[group.component].split(' ')[0]
                        : '?'}
                    </span>
                  </span>
                ))}
              </div>

              {!row.isCorrect && row.errorReason && (
                <p className="mt-1 text-[11px] text-red-700">错因：{row.errorReason}</p>
              )}

              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] text-inkMuted">
                  成分标注数：
                  {SENTENCE_COMPONENTS.map(
                    (component) =>
                      `${SENTENCE_COMPONENT_LABEL_ZH[component].split(' ')[0]}${
                        row.tokens.filter((token) => token.component === component).length
                      }`,
                  ).join(' / ')}
                </p>
                <Button variant="danger" size="sm" onClick={() => setArchiving(row)}>
                  归档
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={archiving !== null}
        title="归档这条句子分析？"
        description="归档后不再出现在列表与统计中（软删除，数据库仍保留）。"
        confirmLabel="确认归档"
        busy={pending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiving(null)}
      />
    </>
  );
}
