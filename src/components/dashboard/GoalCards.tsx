/**
 * Dashboard ⓪ 三目标卡：三条轨道并行三列。
 *
 * 三条轨道**各自独立**，不做合计、不生成「总能力分」——
 * 这是 SOP v2 §2 的核心约束：General English（长期 B2）、IELTS（可配置）、
 * English-mediated Learning（跨技能应用）三者不能用同一个数字概括。
 *
 * 每张卡都展示 `basis`（判定依据），让用户能核对「凭什么这么说」。
 * 证据不足时 `progress` 为 `null`，显示「证据不足」而不是 0%。
 */

import Link from 'next/link';
import { GOAL_HREF } from '@/lib/constants';
import { formatPercent } from '@/lib/format';
import type { GoalCardDto, GoalType } from '@/lib/types';
import { Card } from '@/components/ui/Card';

const GOAL_ACCENT: Record<GoalType, string> = {
  GENERAL_ENGLISH: 'border-l-brand',
  IELTS: 'border-l-amber-500',
  ENGLISH_MEDIATED_LEARNING: 'border-l-slate-500',
};

const GOAL_TAG: Record<GoalType, string> = {
  GENERAL_ENGLISH: '长期',
  IELTS: '阶段考试',
  ENGLISH_MEDIATED_LEARNING: '跨技能应用',
};

function GoalCell({ goal }: { goal: GoalCardDto }) {
  const hasProgress = goal.progress !== null;

  return (
    <div
      className={[
        'flex flex-col gap-1.5 rounded-md border border-line border-l-2 bg-surface p-2.5',
        GOAL_ACCENT[goal.goalType],
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold text-ink">{goal.labelZh}</p>
          <p className="text-[10px] text-inkMuted">{GOAL_TAG[goal.goalType]}</p>
        </div>
        <Link
          href={GOAL_HREF[goal.goalType]}
          className="shrink-0 text-[10px] text-brand underline-offset-2 hover:underline"
        >
          详情 →
        </Link>
      </div>

      <div>
        <p className="text-[10px] text-inkMuted">目标</p>
        <p className="text-[11px] text-ink">{goal.targetText}</p>
      </div>

      <div>
        <p className="text-[10px] text-inkMuted">当前</p>
        <p className="text-[11px] text-ink">{goal.currentText}</p>
      </div>

      {/* 里程碑达成度（证据不足时显示「证据不足」而非 0%） */}
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 flex-1 overflow-hidden rounded bg-line" aria-hidden="true">
          <span
            className="block h-full rounded bg-brand"
            style={{ width: hasProgress ? `${Math.round((goal.progress as number) * 100)}%` : '0%' }}
          />
        </span>
        <span className="tabular w-12 shrink-0 text-right text-[10px] text-inkMuted">
          {hasProgress ? formatPercent(goal.progress as number) : '证据不足'}
        </span>
      </div>

      {goal.unmet.length > 0 && (
        <ul className="mt-0.5 space-y-0.5">
          {goal.unmet.slice(0, 3).map((item, i) => (
            <li key={i} className="text-[10px] leading-tight text-inkMuted">
              · {item}
            </li>
          ))}
          {goal.unmet.length > 3 && (
            <li className="text-[10px] text-inkMuted">… 另有 {goal.unmet.length - 3} 项</li>
          )}
        </ul>
      )}
    </div>
  );
}

export function GoalCards({ goals }: { goals: GoalCardDto[] }) {
  if (goals.length === 0) return null;

  return (
    <Card
      title="三条学习目标"
      description="三条轨道各自独立统计与验收，不合并成一个总分。CEFR 评估、IELTS 成绩、媒介学习能力三者不可互相换算。"
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {goals.map((goal) => (
          <GoalCell key={goal.goalType} goal={goal} />
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-inkMuted">
        判定依据：
        {goals.map((goal, i) => (
          <span key={goal.goalType}>
            {i > 0 ? '；' : ''}
            {goal.labelZh} — {goal.basis}
          </span>
        ))}
      </p>
    </Card>
  );
}
