'use client';

/**
 * 计划任务行。
 *
 * 一行里同时承载：模块信息 / 计划时长（就地改）/ 实际时长 / 状态 / 资源 / 计时 / 结果标记。
 * 「计划时长」与「实际时长」严格分列且带不同底色 —— 这两类量不允许在 UI 上合并。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DragEvent } from 'react';
import { updatePlanTaskAction, deletePlanTaskAction } from '@/lib/actions/plan';
import { PRIMARY_SKILL_LABEL_ZH, SKILL_LABEL_ZH, TASK_PRIORITY_LABEL_ZH, TRACK_LABEL_ZH } from '@/lib/constants';
import { formatDurationZh } from '@/lib/format';
import type { PlanTaskDto, ResourceOptionDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Icon } from '@/components/ui/Icon';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { inputClass } from '@/components/ui/FormField';
import { TaskStatusMenu } from './TaskStatusMenu';
import { TimerPanel } from './TimerPanel';

export interface TaskRowProps {
  task: PlanTaskDto;
  planDate: string;
  resources: ResourceOptionDto[];
  index: number;
  total: number;
  onToast: (message: string, tone: 'success' | 'error') => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  drag: {
    dragging: boolean;
    onDragStart: (event: DragEvent<HTMLLIElement>) => void;
    onDragOver: (event: DragEvent<HTMLLIElement>) => void;
    onDrop: (event: DragEvent<HTMLLIElement>) => void;
    onDragEnd: () => void;
  };
}

export function TaskRow({
  task,
  planDate,
  resources,
  index,
  total,
  onToast,
  onMoveUp,
  onMoveDown,
  drag,
}: TaskRowProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [planned, setPlanned] = useState(task.plannedMinutes);
  const [resourceId, setResourceId] = useState(task.resourceId ?? '');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const savePlanned = (value: number) => {
    if (value === task.plannedMinutes || value < 1) return;
    startTransition(async () => {
      const result = await updatePlanTaskAction({ taskId: task.id, plannedMinutes: value });
      if (!result.ok) {
        onToast(result.error, 'error');
        setPlanned(task.plannedMinutes);
        return;
      }
      onToast(`计划时长已改为 ${value} 分钟`, 'success');
      router.refresh();
    });
  };

  const saveResource = (value: string) => {
    setResourceId(value);
    startTransition(async () => {
      const result = await updatePlanTaskAction({ taskId: task.id, resourceId: value });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      router.refresh();
    });
  };

  const onDelete = () => {
    startTransition(async () => {
      const result = await deletePlanTaskAction({ taskId: task.id });
      setDeleteOpen(false);
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('任务已删除', 'success');
      router.refresh();
    });
  };

  return (
    <li
      draggable
      onDragStart={drag.onDragStart}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      onDragEnd={drag.onDragEnd}
      className={[
        'rounded-md border bg-surface p-2.5 transition-shadow',
        drag.dragging ? 'border-brand opacity-60' : 'border-line',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex items-center gap-1 text-inkMuted">
          <span aria-hidden="true" className="cursor-grab select-none" title="拖拽调整顺序">
            ⠿
          </span>
          <div className="flex flex-col">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={index === 0}
              aria-label="上移"
              className="leading-none disabled:opacity-30"
            >
              <Icon name="up" size={10} />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={index === total - 1}
              aria-label="下移"
              className="leading-none disabled:opacity-30"
            >
              <Icon name="down" size={10} />
            </button>
          </div>
        </div>

        <div className="min-w-[150px] flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-ink">{task.moduleLabel}</span>
            {task.priority !== 'P1' && (
              <span
                className={[
                  'rounded px-1 py-0.5 text-[10px] font-medium',
                  task.priority === 'P0'
                    ? 'bg-rose-100 text-rose-800'
                    : task.priority === 'P2'
                      ? 'bg-amber-100 text-amber-900'
                      : 'bg-slate-100 text-slate-700',
                ].join(' ')}
                title={TASK_PRIORITY_LABEL_ZH[task.priority]}
              >
                {task.priority}
              </span>
            )}
            {task.splittable && (
              <span className="rounded bg-surfaceAlt px-1 py-0.5 text-[10px] text-inkMuted">
                可拆 · 最小 {task.minChunkMinutes} 分钟
              </span>
            )}
            <span className="rounded bg-surfaceAlt px-1 py-0.5 text-[10px] text-inkMuted">
              {TRACK_LABEL_ZH[task.track]}
            </span>
            <span className="text-[11px] text-inkMuted">
              {SKILL_LABEL_ZH[task.skill] ?? task.skill} · {PRIMARY_SKILL_LABEL_ZH[task.primarySkill]}
            </span>
          </div>
          {task.note && <p className="mt-0.5 text-[11px] text-inkMuted">{task.note}</p>}
          {task.estimate && (
            <p className="mt-0.5 text-[11px] text-inkMuted">
              估时 {task.estimate.minMinutes}–{task.estimate.maxMinutes} 分钟
              {task.estimate.basis === 'CALIBRATED'
                ? ` · 历史校准 ${task.estimate.sampleCount} 样本`
                : ' · 估计'}
              {` · 模型 ${task.estimate.modelVersion} / 规则 ${task.estimate.ruleVersion}`}
            </p>
          )}
          {task.expectedOutput && <p className="mt-0.5 text-[11px] text-inkMuted">预期产出：{task.expectedOutput}</p>}
          {task.status === 'DEFERRED' && task.deferReason && (
            <p className="mt-0.5 text-[11px] text-amber-800">已延期：{task.deferReason}</p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-[11px] text-inkMuted">
            计划
            <input
              type="number"
              min={1}
              max={600}
              value={planned}
              disabled={pending}
              onChange={(event) => setPlanned(Number(event.target.value))}
              onBlur={(event) => savePlanned(Number(event.target.value))}
              className="tabular w-14 rounded border border-blue-200 bg-blue-50 px-1 py-0.5 text-center text-[12px] text-ink"
              aria-label={`${task.moduleLabel} 计划分钟`}
            />
            分
          </label>

          <span className="tabular rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-800">
            实际 {formatDurationZh(task.actualMinutes)}
          </span>

          <StatusBadge status={task.status} />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <select
          value={resourceId}
          disabled={pending}
          onChange={(event) => saveResource(event.target.value)}
          className={`${inputClass} max-w-[220px] py-1 text-[11px]`}
          aria-label={`${task.moduleLabel} 关联资源`}
        >
          <option value="">未关联资源</option>
          {resources.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.isPrimary ? '★ ' : ''}
              {resource.name}
            </option>
          ))}
        </select>

        <TimerPanel task={task} />
        <TaskStatusMenu task={task} planDate={planDate} onDone={onToast} />

        <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(true)} aria-label="删除任务">
          <Icon name="trash" size={12} />
        </Button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title="删除这条计划任务？"
        description="只有在还没有任何计时记录时才能删除。已产生计时记录的任务请改为「标记未完成」，否则历史时长会失真。"
        confirmLabel={pending ? '处理中…' : '确认删除'}
        busy={pending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />
    </li>
  );
}
