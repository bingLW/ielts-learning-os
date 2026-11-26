/**
 * 受保护任务公告：已完成 / 计时中 / 已产生实际分钟的任务，重排**不得改写**。
 *
 * 放在表单上方而不是表格里：用户先知道「哪些动不了」，再看 diff 才不会误解。
 */

import { Card } from '@/components/ui/Card';
import type { ReplanContextDto } from '@/lib/queries/planner';

const TIMER_LABEL: Record<string, string> = {
  IDLE: '未计时',
  RUNNING: '计时中',
  PAUSED: '暂停中',
  DONE: '已结束',
};

export function ProtectedNotice({ tasks }: { tasks: ReplanContextDto['tasks'] }) {
  const protectedRows = tasks.filter((task) => task.protected);
  return (
    <Card
      dense
      title={`受保护任务（${protectedRows.length} 条）`}
      description="已完成、计时中或已产生实际分钟的任务不会被重排改写"
    >
      {protectedRows.length === 0 ? (
        <p className="text-xs text-inkMuted">当前没有受保护任务，全部任务都可参与重排。</p>
      ) : (
        <ul className="space-y-1">
          {protectedRows.map((task) => (
            <li key={task.taskId} className="text-xs text-ink">
              {task.moduleLabel}
              <span className="ml-1 text-inkMuted">
                · {task.status} · 计时 {TIMER_LABEL[task.timerStatus] ?? task.timerStatus} · 计划{' '}
                {task.plannedMinutes} 分钟
                {task.actualMinutes > 0 ? ` · 实际 ${task.actualMinutes} 分钟` : ''} · 不会被改写
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}