'use client';

/**
 * 计划页主体（客户端）。
 *
 * 由服务端组件传入已算好的 DTO，这一层只做交互与布局，
 * 所有业务数值（完成率、净值、语法上限）都在服务端算好，前端不复算。
 */

import { TASK_STATUSES_EXCLUDED_FROM_RATE } from '@/lib/constants';
import { formatDurationZh, formatPercent } from '@/lib/format';
import type { PlanPageDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';
import { DailySummaryCard } from './DailySummaryCard';
import { BudgetPicker } from './BudgetPicker';
import { PlanEmptyState } from './PlanEmptyState';
import { PlanToolbar, type WeekStripDayView } from './PlanToolbar';
import { TaskList } from './TaskList';

export interface PlanPageBodyProps {
  data: PlanPageDto;
  todayStr: string;
  weekStrip: WeekStripDayView[];
}

export function PlanPageBody({ data, todayStr, weekStrip }: PlanPageBodyProps) {
  const { toast, show, dismiss } = useToastState();
  const hasTasks = data.tasks.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">学习计划 · {data.planDate}</h1>
          <p className="text-xs text-inkMuted">
            {data.stageName ?? '尚未激活阶段'} · 时区 Asia/Singapore · 计划与实际严格分列
          </p>
        </div>
      </div>

      <PlanToolbar
        planDate={data.planDate}
        todayStr={todayStr}
        weekStrip={weekStrip}
        dailyMinutesPreset={data.budget.minutes}
        hasTasks={hasTasks}
        onToast={show}
      />

      <Card
        title="时间预算"
        description="今天有多少净学习时间由你决定；预算变化只重排未开始的任务，已发生的学习记录不改写。"
      >
        <BudgetPicker
          planDate={data.planDate}
          budget={data.budget}
          hasTasks={hasTasks}
          actualMinutesToday={data.netMinutes}
          planVersionCount={data.planVersionCount}
          retestPlannedMinutes={data.retestPlannedMinutes}
          onToast={show}
        />
      </Card>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="计划时长"
          value={formatDurationZh(data.totalPlannedMinutes)}
          tone="plan"
          hint={`${data.tasks.filter((task) => !TASK_STATUSES_EXCLUDED_FROM_RATE.includes(task.status)).length} 个任务`}
          scopeNote="当日排入任务的 planned_minutes 之和（不含取消/延期）"
        />
        <StatTile
          label="实际净时长"
          value={formatDurationZh(data.netMinutes)}
          tone="actual"
          hint="来自计时段的跨零点拆分求和"
          scopeNote="剔除中断与误触后的有效分钟"
        />
        <StatTile
          label="完成率（按时长加权）"
          value={formatPercent(data.completion.byTime)}
          tone="output"
          hint={`任务数完成率 ${formatPercent(data.completion.byCount)}`}
          scopeNote="Σ(权重×计划) / Σ计划，分母为 0 时显示 —"
        />
        <StatTile
          label="语法类占比上限"
          value={formatPercent(
            data.totalPlannedMinutes > 0
              ? data.grammarPlannedMinutes / data.totalPlannedMinutes
              : null,
          )}
          tone={data.grammarOverCap ? 'warn' : 'mastery'}
          hint={`语法/句子 ${data.grammarPlannedMinutes} 分 · 上限 ${data.grammarCapMinutes} 分（阶段一 20%）`}
          scopeNote="仅阶段一受 20% 硬约束"
        />
      </div>

      {data.grammarOverCap && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
          <span>
            语法类任务合计 {data.grammarPlannedMinutes} 分钟，已超过阶段一「当日总时长 20%」上限
            {data.grammarCapMinutes} 分钟。建议下调语法任务时长，把时间让给听力精听/阅读/口语。
          </span>
        </div>
      )}

      {hasTasks ? (
        <Card
          title="今日任务"
          description="顺序遵循 SOP 主线：词汇复习 → 语法句型 → 听力 → 阅读 → 口语 → 写作 → 句子成分 → 复盘 → 泛听泛读。可拖拽或用箭头调序。"
        >
          <TaskList
            tasks={data.tasks}
            planDate={data.planDate}
            resources={data.availableResources}
            onToast={show}
          />
        </Card>
      ) : (
        <PlanEmptyState
          planDate={data.planDate}
          dailyMinutesPreset={data.budget.minutes}
          onToast={show}
        />
      )}

      <DailySummaryCard
        planDate={data.planDate}
        summary={data.dailySummary}
        netMinutes={data.netMinutes}
        completionByTime={data.completion.byTime}
        onToast={show}
      />

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
