'use client';

/**
 * 提升候选优先级（只改决策层，不写 PlanTask）。
 *
 * 升到 P0 需要二次确认：P0 是「到期复习」的约定档位，手工把拓展任务提成 P0
 * 会破坏「P0 = 到期」这个语义，所以先弹出说明再提交。
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { promoteCandidateAction } from '@/lib/actions/planner';
import type { TaskPriority } from '@/lib/types';

const NEXT_PRIORITY: Partial<Record<TaskPriority, TaskPriority>> = {
  P3: 'P2',
  P2: 'P1',
  P1: 'P0',
};

export function PromoteCandidateButton({
  candidateId,
  priority,
}: {
  candidateId: string;
  priority: TaskPriority;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const next = NEXT_PRIORITY[priority];

  if (!next) {
    return <span className="text-[11px] text-inkMuted">已是 P0</span>;
  }

  const promote = () => {
    const note = next === 'P0' ? 'P0 是到期复习的约定档位，确认把这条提到 P0？' : null;
    if (note && typeof window !== 'undefined' && !window.confirm(note)) return;
    startTransition(async () => {
      const result = await promoteCandidateAction({ candidateId, priority: next });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setMessage(null);
      router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Button variant="ghost" size="sm" onClick={promote} disabled={pending}>
        {pending ? '提交中…' : `提升到 ${next}`}
      </Button>
      {message && <span className="text-[11px] text-red-700">{message}</span>}
    </span>
  );
}