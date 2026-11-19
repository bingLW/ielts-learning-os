'use client';

/**
 * 词汇清单（T26）。<768px 卡片列表；归档需二次确认。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveVocabWordAction } from '@/lib/actions/vocab';
import { MASTERY_LEVELS } from '@/lib/constants';
import type { VocabWordRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TagBadge } from '@/components/ui/StatusBadge';

/** 三档使用不同的徽章语气，避免只靠颜色区分。 */
function masteryTone(mastery: string): 'neutral' | 'warn' | 'info' {
  if (mastery === 'ACTIVE_USE') return 'info';
  if (mastery === 'COMPREHEND') return 'neutral';
  return 'warn';
}

export function VocabTable({
  rows,
  onEdit,
  onToast,
}: {
  rows: VocabWordRowDto[];
  onEdit: (row: VocabWordRowDto) => void;
  onToast: (message: string, tone: 'success' | 'error') => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [archiving, setArchiving] = useState<VocabWordRowDto | null>(null);

  const confirmArchive = () => {
    if (!archiving) return;
    startTransition(async () => {
      const result = await archiveVocabWordAction({ id: archiving.id });
      onToast(result.ok ? '单词已归档' : result.error, result.ok ? 'success' : 'error');
      setArchiving(null);
      if (result.ok) router.refresh();
    });
  };

  const masteryOrder = (mastery: string) => {
    const index = (MASTERY_LEVELS as readonly string[]).indexOf(mastery);
    return index < 0 ? MASTERY_LEVELS.length : index;
  };

  return (
    <>
      <div className="hidden md:block">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-inkMuted">
              <th className="py-1.5 pr-2 font-medium">单词</th>
              <th className="py-1.5 pr-2 font-medium">释义</th>
              <th className="py-1.5 pr-2 font-medium">搭配 / 例句</th>
              <th className="py-1.5 pr-2 font-medium">掌握度</th>
              <th className="py-1.5 pr-2 font-medium">学习日</th>
              <th className="py-1.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line align-top">
                <td className="py-1.5 pr-2">
                  <span className="font-medium text-ink">{row.word}</span>
                  {row.phonetic && <span className="ml-1 text-[11px] text-inkMuted">{row.phonetic}</span>}
                  {row.partOfSpeech && (
                    <span className="ml-1 text-[10px] text-inkMuted">{row.partOfSpeech}</span>
                  )}
                  {row.isNew && (
                    <span className="ml-1">
                      <TagBadge tone="info">新词</TagBadge>
                    </span>
                  )}
                </td>
                <td className="max-w-[200px] py-1.5 pr-2 text-[11px]">
                  {row.meaningZh}
                  {row.meaningEn && <div className="text-inkMuted">{row.meaningEn}</div>}
                </td>
                <td className="max-w-[240px] py-1.5 pr-2 text-[11px] text-inkMuted">
                  {row.collocation ?? '—'}
                  {row.exampleSentence && <div>{row.exampleSentence}</div>}
                </td>
                <td className="py-1.5 pr-2">
                  <TagBadge tone={masteryTone(row.mastery)}>{row.masteryLabel}</TagBadge>
                </td>
                <td className="tabular py-1.5 pr-2 text-[11px] text-inkMuted">{row.learnedDate}</td>
                <td className="py-1.5">
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onEdit(row)}>
                      编辑
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setArchiving(row)}>
                      归档
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="rounded-md border border-line bg-white p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {row.word}
                  {row.phonetic && (
                    <span className="ml-1 text-[11px] font-normal text-inkMuted">{row.phonetic}</span>
                  )}
                </p>
                <p className="text-[11px] text-inkMuted">{row.meaningZh}</p>
              </div>
              <TagBadge tone={masteryTone(row.mastery)}>{row.masteryLabel}</TagBadge>
            </div>
            {row.exampleSentence && (
              <p className="mt-1 text-[11px] text-inkMuted">{row.exampleSentence}</p>
            )}
            <div className="mt-2 flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => onEdit(row)}>
                编辑
              </Button>
              <Button variant="danger" size="sm" onClick={() => setArchiving(row)}>
                归档
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[11px] text-inkMuted">
        排序提示：按掌握度从低到高逐档推进（{MASTERY_LEVELS.length} 档独立统计）。
        当前页最低档：{rows.map((row) => row.mastery).sort((a, b) => masteryOrder(a) - masteryOrder(b))[0] ?? '—'}
      </p>

      <ConfirmDialog
        open={archiving !== null}
        title={`归档单词「${archiving?.word ?? ''}」？`}
        description="归档后不再出现在抽测与复习队列；数据库里仍保留（软删除）。"
        confirmLabel="确认归档"
        busy={pending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiving(null)}
      />
    </>
  );
}
