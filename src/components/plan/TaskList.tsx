'use client';

/**
 * 任务列表 + 调序。
 *
 * 调序有两套入口，都写同一份 `sortOrder`：
 * - 原生 HTML5 拖拽（鼠标/触屏长按）；
 * - 上下箭头按钮（键盘可达 —— 拖拽对键盘用户不可用，所以必须提供替代路径）。
 */

import { useEffect, useState, useTransition, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { reorderPlanTasksAction } from '@/lib/actions/plan';
import type { PlanTaskDto, ResourceOptionDto } from '@/lib/types';
import { TaskRow } from './TaskRow';

export interface TaskListProps {
  tasks: PlanTaskDto[];
  planDate: string;
  resources: ResourceOptionDto[];
  onToast: (message: string, tone: 'success' | 'error') => void;
}

export function TaskList({ tasks, planDate, resources, onToast }: TaskListProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [order, setOrder] = useState<string[]>(tasks.map((task) => task.id));
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // 服务端数据变化后同步本地顺序
  useEffect(() => {
    setOrder(tasks.map((task) => task.id));
  }, [tasks]);

  const orderedTasks = order
    .map((id) => tasks.find((task) => task.id === id))
    .filter((task): task is PlanTaskDto => Boolean(task));

  const persist = (nextIds: string[]) => {
    setOrder(nextIds);
    startTransition(async () => {
      const result = await reorderPlanTasksAction({ planDate, orderedIds: nextIds });
      if (!result.ok) {
        onToast(result.error, 'error');
        setOrder(tasks.map((task) => task.id));
        return;
      }
      onToast('顺序已保存', 'success');
      router.refresh();
    });
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= orderedTasks.length) return;
    const next = orderedTasks.map((task) => task.id);
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    persist(next);
  };

  const onDrop = (event: DragEvent<HTMLLIElement>, targetId: string) => {
    event.preventDefault();
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null);
      return;
    }
    const next = orderedTasks.map((task) => task.id);
    const from = next.indexOf(draggingId);
    const to = next.indexOf(targetId);
    if (from < 0 || to < 0) {
      setDraggingId(null);
      return;
    }
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDraggingId(null);
    persist(next);
  };

  return (
    <ul className={['space-y-2', pending ? 'opacity-80' : ''].join(' ')}>
      {orderedTasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          planDate={planDate}
          resources={resources}
          index={index}
          total={orderedTasks.length}
          onToast={onToast}
          onMoveUp={() => move(index, -1)}
          onMoveDown={() => move(index, 1)}
          drag={{
            dragging: draggingId === task.id,
            onDragStart: (event) => {
              setDraggingId(task.id);
              event.dataTransfer.effectAllowed = 'move';
            },
            onDragOver: (event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            },
            onDrop: (event) => onDrop(event, task.id),
            onDragEnd: () => setDraggingId(null),
          }}
        />
      ))}
    </ul>
  );
}
