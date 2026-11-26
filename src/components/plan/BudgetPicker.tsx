'use client';

/** Legacy `/plan` 预算展示：所有修改与重排都转统一 Planner 页面。 */

import Link from 'next/link';
import {
  EVIDENCE_LEVEL_LABEL_ZH,
  tierLabelZh,
} from '@/lib/constants';
import { evidenceHintForBudget } from '@/lib/domain/planFusion';
import { buttonClass } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { PlanBudgetDto } from '@/lib/types';

export interface BudgetPickerProps {
  planDate: string;
  budget: PlanBudgetDto;
  hasTasks: boolean;
  actualMinutesToday: number;
  planVersionCount: number;
  retestPlannedMinutes: number;
}

const SOURCE_LABEL: Record<PlanBudgetDto['source'], string> = {
  USER: '已由你设定',
  WEEKDAY_TEMPLATE: '按星期模板',
  DEFAULT_SUGGESTION: '系统建议',
  MIGRATION: '迁移值',
};

export function BudgetPicker({
  planDate,
  budget,
  hasTasks,
  actualMinutesToday,
  planVersionCount,
  retestPlannedMinutes,
}: BudgetPickerProps) {
  const evidenceHint = evidenceHintForBudget(budget.minutes);
  const buildHref = `/planner/build?horizon=1&date=${encodeURIComponent(planDate)}&budget=${budget.minutes}`;
  const replanHref = `/planner/replan?date=${encodeURIComponent(planDate)}`;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link href={`/planner/budget?week=${encodeURIComponent(planDate)}`} className={buttonClass('secondary', 'sm')}>
          <Icon name="calendar" size={12} />
          调整时间预算
        </Link>
        <Link href={hasTasks ? replanHref : buildHref} className={buttonClass('primary', 'sm')}>
          <Icon name={hasTasks ? 'repeat' : 'plus'} size={12} />
          {hasTasks ? '预览重排' : '预览并生成计划'}
        </Link>
        {hasTasks && (
          <Link href={buildHref} className={buttonClass('ghost', 'sm')}>
            重新构建
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-inkMuted">
        <span
          className={[
            'rounded px-1.5 py-0.5',
            budget.isSuggestion
              ? 'border border-amber-300 bg-amber-50 text-amber-900'
              : 'border border-line bg-surfaceAlt',
          ].join(' ')}
        >
          当前预算 {budget.minutes} 分钟 · {SOURCE_LABEL[budget.source]}
          {budget.isSuggestion ? '（尚未确认，不是真实可用时间）' : ''}
        </span>
        {budget.isRestDay && <span>休息日：不生成强制任务，不计为学习失败</span>}
        {planVersionCount > 1 && <span>今日已调整 {planVersionCount} 个计划版本</span>}
        {actualMinutesToday > 0 && (
          <span className="text-emerald-700">
            已发生 {actualMinutesToday} 分钟 · 改预算只重排剩余部分
          </span>
        )}
        {budget.tierCode && <span>档位：{tierLabelZh(budget.tierCode)}</span>}
        {retestPlannedMinutes > 0 && (
          <span className="text-emerald-700">
            含证据复测 {retestPlannedMinutes} 分钟（已计入预算，不重复计时）
          </span>
        )}
      </div>

      <p className="text-[11px] text-inkMuted">
        证据记录级别：
        {evidenceHint.level ? EVIDENCE_LEVEL_LABEL_ZH[evidenceHint.level] : '不强制（维护模式）'} ·{' '}
        {evidenceHint.advice}
      </p>

      {budget.minutes > 0 && budget.minutes < 15 && (
        <p className="text-[11px] text-inkMuted">
          少于 15 分钟属于微学习 / 维护模式，只保证记忆连续性，不算完整学习日。
        </p>
      )}
      <p className="text-[11px] text-inkMuted">
        本页为 Legacy 计划查看与执行入口；生成、预算修改和重排统一在 Planner 中预览后确认。
      </p>
    </div>
  );
}
