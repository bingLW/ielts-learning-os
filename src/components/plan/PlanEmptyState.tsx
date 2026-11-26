'use client';

/**
 * 空态下的生成入口（需要把 onClick 放在客户端边界内）。
 */

import { EmptyState } from '@/components/ui/EmptyState';
import { GeneratePlanButton } from './PlanToolbar';

export function PlanEmptyState({
  planDate,
  dailyMinutesPreset,
}: {
  planDate: string;
  dailyMinutesPreset: number;
}) {
  return (
    <div className="space-y-2">
      <EmptyState
        icon="calendar"
        title="这一天还没有计划"
        description="按当日预算自适应生成计划：阶段零做 3 项基线诊断；训练阶段按优先级排复习、核心技能与弱项，预算多少排多少，不凑时长。"
        dependencies={[
          '已存在 ACTIVE 阶段（阶段零只会生成基线诊断任务）',
          '预算未确认时按建议值生成，可在上方「时间预算」卡片进入 Planner 修改',
          '资源库已 seed（用于自动挂主材料）',
        ]}
      />
      <div className="flex justify-center">
        <GeneratePlanButton
          planDate={planDate}
          dailyMinutesPreset={dailyMinutesPreset}
          hasTasks={false}
        />
      </div>
    </div>
  );
}
