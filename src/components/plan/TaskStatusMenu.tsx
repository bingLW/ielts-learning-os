'use client';

/**
 * 任务状态菜单：完成 / 部分完成 / 未完成 / 顺延。
 *
 * 非法流转不会出现在菜单里（白名单来自 `TASK_TRANSITIONS`），
 * 服务端仍会再校验一次 —— 前端只做「不给出错的按钮」，不承担校验责任。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { TASK_STATUS_LABEL_ZH, TASK_TRANSITIONS } from '@/lib/constants';
import { addDays } from '@/lib/date';
import { finishTaskAction, moveTaskToDateAction } from '@/lib/actions/task';
import type { PlanTaskDto, TaskStatus } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FormField, inputClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';

export interface TaskStatusMenuProps {
  task: PlanTaskDto;
  planDate: string;
  onDone: (message: string, tone: 'success' | 'error') => void;
}

const REASON_OPTIONS = ['时间不足', '状态差', '材料不合适', '计划变化', '其他'];

export function TaskStatusMenu({ task, planDate, onDone }: TaskStatusMenuProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [partialMinutes, setPartialMinutes] = useState<number>(task.actualMinutes);
  const [missReason, setMissReason] = useState<string>(REASON_OPTIONS[0]);
  const [deferReason, setDeferReason] = useState<string>('预算不足，主动延期');
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetDate, setTargetDate] = useState<string>(addDays(planDate, 1));

  const allowed = TASK_TRANSITIONS[task.status as TaskStatus] ?? [];

  const submitOutcome = (outcome: 'DONE' | 'PARTIAL' | 'MISSED' | 'CANCELLED' | 'DEFERRED') => {
    startTransition(async () => {
      const result = await finishTaskAction({
        taskId: task.id,
        outcome,
        actualMinutes: outcome === 'PARTIAL' ? partialMinutes : undefined,
        missReason: outcome === 'MISSED' ? missReason : outcome === 'DEFERRED' ? deferReason : undefined,
      });
      if (!result.ok) {
        onDone(result.error, 'error');
        return;
      }
      onDone(`已标记为「${TASK_STATUS_LABEL_ZH[result.data.status]}」`, 'success');
      setOpen(false);
      router.refresh();
    });
  };

  const submitMove = () => {
    startTransition(async () => {
      const result = await moveTaskToDateAction({ taskId: task.id, targetDate });
      if (!result.ok) {
        onDone(result.error, 'error');
        setMoveOpen(false);
        return;
      }
      onDone(`已顺延到 ${result.data.movedToDate}`, 'success');
      setMoveOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button variant="secondary" size="sm" onClick={() => setOpen((value) => !value)}>
        标记结果
        <Icon name={open ? 'up' : 'down'} size={11} />
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setMoveOpen(true)}>
        顺延
      </Button>

      {open && (
        <div className="mt-1 w-full rounded-md border border-line bg-surfaceAlt p-2">
          <div className="flex flex-wrap gap-1.5">
            {allowed.includes('DONE') && (
              <Button variant="primary" size="sm" onClick={() => submitOutcome('DONE')} disabled={pending}>
                <Icon name="check" size={12} />
                已完成
              </Button>
            )}
            {allowed.includes('PARTIAL') && (
              <Button variant="secondary" size="sm" onClick={() => submitOutcome('PARTIAL')} disabled={pending}>
                部分完成
              </Button>
            )}
            {allowed.includes('MISSED') && (
              <Button variant="secondary" size="sm" onClick={() => submitOutcome('MISSED')} disabled={pending}>
                未完成
              </Button>
            )}
            {allowed.includes('CANCELLED') && (
              <Button variant="ghost" size="sm" onClick={() => submitOutcome('CANCELLED')} disabled={pending}>
                取消任务
              </Button>
            )}
            {allowed.includes('DEFERRED') && (
              <Button variant="ghost" size="sm" onClick={() => submitOutcome('DEFERRED')} disabled={pending}>
                延期
              </Button>
            )}
            {allowed.length === 0 && (
              <span className="text-[11px] text-inkMuted">
                该任务已是终态（已完成）。如需重做，请顺延到新日期。
              </span>
            )}
          </div>

          {allowed.includes('PARTIAL') && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <FormField label="实际分钟（部分完成必填）" htmlFor={`partial-${task.id}`}>
                <input
                  id={`partial-${task.id}`}
                  type="number"
                  min={1}
                  max={600}
                  value={partialMinutes}
                  onChange={(event) => setPartialMinutes(Number(event.target.value))}
                  className={inputClass}
                />
              </FormField>
              {allowed.includes('MISSED') && (
                <FormField label="未完成原因" htmlFor={`reason-${task.id}`}>
                  <select
                    id={`reason-${task.id}`}
                    value={missReason}
                    onChange={(event) => setMissReason(event.target.value)}
                    className={inputClass}
                  >
                    {REASON_OPTIONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {reason}
                      </option>
                    ))}
                  </select>
                </FormField>
              )}
            </div>
          )}

          {allowed.includes('DEFERRED') && (
            <div className="mt-2">
              <FormField label="延期原因（记入审计，便于分析中断模式）" htmlFor={`defer-${task.id}`}>
                <input
                  id={`defer-${task.id}`}
                  type="text"
                  maxLength={500}
                  value={deferReason}
                  onChange={(event) => setDeferReason(event.target.value)}
                  className={inputClass}
                  placeholder="预算不足 / 计划变化 / 临时事务 / 其他"
                />
              </FormField>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={moveOpen}
        title="顺延任务到其他日期"
        description={
          <div className="space-y-2">
            <p>
              已顺延 <b className="tabular">{task.movedCount}</b> 次，最多 2 次。顺延会保留原任务行并留下
              moved 痕迹，历史不会被改写。
            </p>
            <FormField label="目标日期" htmlFor={`move-${task.id}`}>
              <input
                id={`move-${task.id}`}
                type="date"
                value={targetDate}
                onChange={(event) => setTargetDate(event.target.value)}
                className={inputClass}
              />
            </FormField>
          </div>
        }
        confirmLabel={pending ? '处理中…' : '确认顺延'}
        danger={false}
        busy={pending}
        onCancel={() => setMoveOpen(false)}
        onConfirm={submitMove}
      />
    </div>
  );
}
