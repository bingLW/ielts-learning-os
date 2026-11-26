'use client';

/**
 * 错题列表 + 批量生成复习任务（T25）。
 *
 * <768px 转卡片列表；归档走二次确认；已掌握的错题不再生成复习任务。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  archiveMistakeAction,
  generateMistakeReviewAction,
  markMistakeMasteredAction,
} from '@/lib/actions/mistakes';
import type { MistakeRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TagBadge } from '@/components/ui/StatusBadge';

export function MistakeList({
  rows,
  onEdit,
  onToast,
}: {
  rows: MistakeRowDto[];
  onEdit: (row: MistakeRowDto) => void;
  onToast: (message: string, tone: 'success' | 'error') => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string[]>([]);
  const [archiving, setArchiving] = useState<MistakeRowDto | null>(null);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  const generate = () => {
    startTransition(async () => {
      const result = await generateMistakeReviewAction({ ids: selected });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast(
        `已生成 ${result.data.created} 条复习任务（跳过 ${result.data.skipped} 条），到期日 ${result.data.dueDate}`,
        'success',
      );
      setSelected([]);
      router.refresh();
    });
  };

  const toggleMastered = (row: MistakeRowDto) => {
    startTransition(async () => {
      const result = await markMistakeMasteredAction({
        id: row.id,
        mastered: !row.isMastered,
      });
      onToast(
        result.ok
          ? result.data.isMastered
            ? '已标记掌握，相关复习任务已跳过'
            : '已取消掌握标记'
          : result.error,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) router.refresh();
    });
  };

  const confirmArchive = () => {
    if (!archiving) return;
    startTransition(async () => {
      const result = await archiveMistakeAction({ id: archiving.id });
      onToast(result.ok ? '错题已归档' : result.error, result.ok ? 'success' : 'error');
      setArchiving(null);
      if (result.ok) router.refresh();
    });
  };

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-inkMuted">已选 {selected.length} 道</p>
        <div className="flex gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={selected.length === 0 || pending}
            onClick={generate}
          >
            从错题生成复习任务
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            清空选择
          </Button>
        </div>
      </div>

      <div className="hidden md:block">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-inkMuted">
              <th className="w-6 py-1.5 font-medium">选</th>
              <th className="py-1.5 pr-2 font-medium">知识点 / 原题</th>
              <th className="py-1.5 pr-2 font-medium">类别</th>
              <th className="py-1.5 pr-2 font-medium">错误原因</th>
              <th className="py-1.5 pr-2 font-medium">复习</th>
              <th className="py-1.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line align-top">
                <td className="py-1.5">
                  <input
                    type="checkbox"
                    checked={selected.includes(row.id)}
                    onChange={() => toggle(row.id)}
                    aria-label={`选择错题 ${row.knowledgePoint}`}
                  />
                </td>
                <td className="max-w-[280px] py-1.5 pr-2">
                  <span className="font-medium text-ink">{row.knowledgePoint}</span>
                  <p className="line-clamp-2 text-[11px] text-inkMuted">{row.originalQuestion}</p>
                  <p className="text-[10px] text-inkMuted">
                    我的答案 {row.myAnswer ?? '—'} / 正确 {row.correctAnswer}
                  </p>
                  <p className="text-[10px] text-inkMuted">
                    {row.studyRecordId ? `学习记录 ${row.studyRecordId.slice(0, 10)}` : '未归属学习记录'}
                  </p>
                </td>
                <td className="py-1.5 pr-2">
                  <TagBadge tone="warn">{row.errorCategoryLabel}</TagBadge>
                  {row.ieltsErrorCategoryLabel && (
                    <div className="mt-0.5">
                      <TagBadge tone="info">{row.ieltsErrorCategoryLabel}</TagBadge>
                    </div>
                  )}
                </td>
                <td className="max-w-[220px] py-1.5 pr-2 text-[11px] text-inkMuted">
                  {row.errorReason}
                </td>
                <td className="py-1.5 pr-2 text-[11px]">
                  {row.isMastered ? (
                    <TagBadge tone="info">已掌握</TagBadge>
                  ) : (
                    <span className="text-inkMuted">
                      复习 {row.reviewCount} 次
                      {row.nextReviewAt ? ` · 下次 ${row.nextReviewAt}` : ''}
                    </span>
                  )}
                </td>
                <td className="py-1.5">
                  <div className="flex flex-wrap gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onEdit(row)}>
                      编辑
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() => toggleMastered(row)}
                    >
                      {row.isMastered ? '取消掌握' : '标记掌握'}
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
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={selected.includes(row.id)}
                onChange={() => toggle(row.id)}
                aria-label={`选择错题 ${row.knowledgePoint}`}
                className="mt-1"
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink">{row.knowledgePoint}</p>
                <p className="line-clamp-2 text-[11px] text-inkMuted">{row.originalQuestion}</p>
                <p className="mt-0.5 text-[10px] text-inkMuted">
                  我的 {row.myAnswer ?? '—'} / 正确 {row.correctAnswer}
                </p>
              </div>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              <TagBadge tone="warn">{row.errorCategoryLabel}</TagBadge>
              {row.isMastered ? <TagBadge tone="info">已掌握</TagBadge> : null}
              <TagBadge>{row.sourceLabel}</TagBadge>
              <span className="text-[10px] text-inkMuted">
                {row.studyRecordId ? `学习记录 ${row.studyRecordId.slice(0, 10)}` : '未归属学习记录'}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <Button variant="ghost" size="sm" onClick={() => onEdit(row)}>
                编辑
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => toggleMastered(row)}
              >
                {row.isMastered ? '取消掌握' : '标记掌握'}
              </Button>
              <Button variant="danger" size="sm" onClick={() => setArchiving(row)}>
                归档
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={archiving !== null}
        title="归档这道错题？"
        description="归档后不再出现在列表与复习队列；历史记录保留在数据库中（软删除）。"
        confirmLabel="确认归档"
        busy={pending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiving(null)}
      />
    </>
  );
}
