'use client';

/**
 * 单元清单（T21）。
 *
 * 响应式：≥768px 表格，<768px 卡片列表（不允许横向滚到底才能看操作按钮）。
 * 删除一律走二次确认。
 */

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveEgiuLessonAction } from '@/lib/actions/egiu';
import type { EgiuLessonRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { ColorBadge } from '@/components/ui/ColorBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TagBadge } from '@/components/ui/StatusBadge';

export interface LessonTableProps {
  rows: EgiuLessonRowDto[];
  onEdit: (row: EgiuLessonRowDto) => void;
  onToast: (message: string, tone: 'success' | 'error') => void;
}

export function LessonTable({ rows, onEdit, onToast }: LessonTableProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [archiving, setArchiving] = useState<EgiuLessonRowDto | null>(null);

  const confirmArchive = () => {
    if (!archiving) return;
    startTransition(async () => {
      const result = await archiveEgiuLessonAction({ id: archiving.id });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('单元已归档，未完成的复习点已跳过', 'success');
      setArchiving(null);
      router.refresh();
    });
  };

  return (
    <>
      {/* 桌面：表格 */}
      <div className="hidden md:block">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-inkMuted">
              <th className="py-1.5 pr-2 font-medium">单元 / 知识点</th>
              <th className="py-1.5 pr-2 font-medium">三色</th>
              <th className="py-1.5 pr-2 font-medium">判定理由</th>
              <th className="py-1.5 pr-2 font-medium">D0</th>
              <th className="py-1.5 pr-2 font-medium">复习</th>
              <th className="py-1.5 pr-2 font-medium">掌握</th>
              <th className="py-1.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line align-top">
                <td className="py-1.5 pr-2">
                  <Link href={`/grammar/${row.id}`} className="font-medium text-brand hover:underline">
                    {row.book} U{row.unitNo}
                  </Link>
                  <div className="text-[11px] text-inkMuted">{row.knowledgePoint}</div>
                </td>
                <td className="py-1.5 pr-2">
                  <ColorBadge color={row.currentColor} score={row.currentScore} />
                </td>
                <td className="max-w-[220px] py-1.5 pr-2 text-[11px] text-inkMuted">
                  {row.currentReason ?? '尚未判定'}
                </td>
                <td className="tabular py-1.5 pr-2 text-[11px] text-inkMuted">{row.learnedDate}</td>
                <td className="py-1.5 pr-2 text-[11px]">
                  {row.pendingReviewCount === 0 ? (
                    <span className="text-inkMuted">无待复习</span>
                  ) : (
                    <span className={row.overdueReviewCount > 0 ? 'text-red-700' : 'text-ink'}>
                      待复习 {row.pendingReviewCount} 条
                      {row.overdueReviewCount > 0 && `（逾期 ${row.overdueReviewCount}）`}
                    </span>
                  )}
                  {row.nextReviewDate && (
                    <div className="text-[10px] text-inkMuted">下次 {row.nextReviewDate}</div>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-[11px]">
                  {row.mastered ? (
                    <TagBadge tone="info">已掌握{row.inLowFreqPool ? ' · 低频池' : ''}</TagBadge>
                  ) : row.greenStreak > 0 ? (
                    <TagBadge tone="warn">连续绿 {row.greenStreak}</TagBadge>
                  ) : (
                    <span className="text-inkMuted">未掌握</span>
                  )}
                </td>
                <td className="py-1.5">
                  <div className="flex flex-wrap gap-1">
                    <Link
                      href={`/grammar/${row.id}`}
                      className="rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink hover:bg-surfaceAlt"
                    >
                      详情 / 复测
                    </Link>
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

      {/* 移动：卡片列表 */}
      <ul className="space-y-2 md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="rounded-md border border-line bg-white p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/grammar/${row.id}`} className="text-sm font-medium text-brand">
                  {row.book} U{row.unitNo}
                </Link>
                <p className="text-[11px] text-inkMuted">{row.knowledgePoint}</p>
              </div>
              <ColorBadge color={row.currentColor} score={row.currentScore} />
            </div>
            <p className="mt-1 text-[11px] text-inkMuted">{row.currentReason ?? '尚未判定'}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-inkMuted">
              <span>D0 {row.learnedDate}</span>
              <span>·</span>
              <span>
                待复习 {row.pendingReviewCount}
                {row.overdueReviewCount > 0 && `（逾期 ${row.overdueReviewCount}）`}
              </span>
              {row.mastered && <TagBadge tone="info">已掌握</TagBadge>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <Link
                href={`/grammar/${row.id}`}
                className="rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink"
              >
                详情 / 复测
              </Link>
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

      <ConfirmDialog
        open={archiving !== null}
        title="归档这个 EGIU 单元？"
        description={
          <span>
            归档后不再出现在列表与复习队列，未完成的复习点会被跳过。
            <b>复测历史不会被删除</b>（append-only）。
          </span>
        }
        confirmLabel="确认归档"
        busy={pending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiving(null)}
      />
    </>
  );
}
