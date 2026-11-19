/**
 * 状态徽章。
 *
 * 无障碍要求：状态不能只用颜色区分，因此每个徽章都是「色点 + 中文文案」，
 * 并且 `title` 属性给出原始英文枚举值便于排查。
 */

import type { ReactNode } from 'react';
import {
  REVIEW_STATUS_LABEL_ZH,
  TASK_STATUS_LABEL_ZH,
} from '@/lib/constants';
import type { ReviewStatus, TaskStatus } from '@/lib/types';

type AnyStatus = TaskStatus | ReviewStatus | string;

const STATUS_CLASS: Record<string, string> = {
  TODO: 'bg-slate-100 text-slate-700 border-slate-300',
  IN_PROGRESS: 'bg-blue-50 text-blue-700 border-blue-300',
  DONE: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  PARTIAL: 'bg-amber-50 text-amber-800 border-amber-300',
  MISSED: 'bg-red-50 text-red-700 border-red-300',
  PENDING: 'bg-slate-100 text-slate-700 border-slate-300',
  SKIPPED: 'bg-slate-100 text-slate-600 border-slate-300',
  SUPERSEDED: 'bg-slate-100 text-slate-500 border-slate-300 line-through',
  NOT_STARTED: 'bg-slate-100 text-slate-700 border-slate-300',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  COMPLETED: 'bg-blue-50 text-blue-700 border-blue-300',
  PASSED: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  FAILED: 'bg-red-50 text-red-700 border-red-300',
};

/** 取中文标签（任务状态 / 复习状态 / 阶段状态 / 判定都有覆盖）。 */
function labelOf(status: AnyStatus): string {
  if (status in TASK_STATUS_LABEL_ZH) {
    return TASK_STATUS_LABEL_ZH[status as TaskStatus];
  }
  if (status in REVIEW_STATUS_LABEL_ZH) {
    return REVIEW_STATUS_LABEL_ZH[status as ReviewStatus];
  }
  const extra: Record<string, string> = {
    NOT_STARTED: '未开始',
    ACTIVE: '进行中',
    COMPLETED: '已完成',
    PASSED: '通过',
    FAILED: '未通过',
  };
  return extra[status] ?? status;
}

export function StatusBadge({ status }: { status: AnyStatus }) {
  const className = STATUS_CLASS[status] ?? 'bg-slate-100 text-slate-700 border-slate-300';
  return (
    <span
      title={status}
      className={[
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        className,
      ].join(' ')}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {labelOf(status)}
    </span>
  );
}

/** 通用小徽章（用于标签类信息，如「主材料」「逾期」）。 */
export function TagBadge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'warn' | 'info';
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-surfaceAlt text-inkMuted border-line',
    warn: 'bg-amber-50 text-amber-800 border-amber-300',
    info: 'bg-blue-50 text-blue-700 border-blue-300',
  };
  return (
    <span
      title={title}
      className={[
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px]',
        tones[tone],
      ].join(' ')}
    >
      {children}
    </span>
  );
}
