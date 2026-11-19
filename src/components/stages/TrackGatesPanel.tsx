'use client';

/**
 * 三轨道独立验收面板（v2.0 P4，展示在 `/stages`）。
 *
 * 三条轨道（通用英语 / IELTS / 媒介学习）各自独立判定，互不换算：
 * 任一未达即该目标未完成。每个卡给出 basis（凭什么这么判断）+ unmet 清单，
 * 并跳转到各自工作区。升级仍需用户在阶段页手动确认。
 */

import Link from 'next/link';
import type { GoalCardDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { TagBadge } from '@/components/ui/StatusBadge';

export function TrackGatesPanel({ goals }: { goals: GoalCardDto[] }) {
  return (
    <Card
      title="三轨道独立验收"
      description="通用英语 / IELTS / 媒介学习分别判定，绝不合并成一个总分；任一未达即该目标未完成。"
    >
      <div className="grid gap-2 md:grid-cols-3">
        {goals.map((goal) => {
          const hasUnmet = goal.unmet.length > 0;
          const noEvidence = goal.progress === null;
          return (
            <div
              key={goal.goalType}
              className="flex flex-col rounded border border-line bg-surfaceAlt p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-ink">{goal.labelZh}</span>
                <TagBadge tone={hasUnmet ? 'warn' : 'info'}>
                  {hasUnmet ? '未达标' : '建议达标'}
                </TagBadge>
              </div>
              <p className="mt-1 text-[11px] text-inkMuted">
                目标 {goal.targetText} · 当前 {goal.currentText}
              </p>
              {noEvidence && (
                <p className="mt-1 text-[11px] text-amber-700">证据不足：进度不显示（不补 0 冒充无进展）</p>
              )}
              {hasUnmet ? (
                <ul className="mt-2 space-y-1">
                  {goal.unmet.map((item) => (
                    <li key={item} className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
                  已满足判定条件（独立验收，不跨轨道折算）
                </p>
              )}
              <div className="mt-auto pt-2">
                <Link
                  href={goal.href}
                  className="text-[11px] font-medium text-brand hover:underline"
                >
                  去工作区查看 →
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
