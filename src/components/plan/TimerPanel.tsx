'use client';

/**
 * 计时面板。
 *
 * 铁律：客户端**只**负责展示与发送 `expectedVersion`。
 * - 显示用的滴答走本地时钟，仅为了让人看到数字在动，绝不回传；
 * - 真正落库的时长由服务端用 `timerStartedAt` 计算（`timerService.closeRunningSession`）；
 * - 心跳每 30 秒一次，只刷 `timerLastActiveAt`，用于「中断 >30min 剔除」的判定。
 */

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { pauseTimerAction, startTimerAction, touchTimerAction } from '@/lib/actions/timer';
import type { PlanTaskDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

const HEARTBEAT_MS = 30_000;

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function TimerPanel({ task }: { task: PlanTaskDto }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [displaySeconds, setDisplaySeconds] = useState(task.timerAccumulatedSeconds);
  const running = task.timerStatus === 'RUNNING';
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 展示用滴答（不回传服务端）
  useEffect(() => {
    if (!running || !task.timerStartedAt) {
      setDisplaySeconds(task.timerAccumulatedSeconds);
      return;
    }
    const startedMs = new Date(task.timerStartedAt).getTime();
    const tick = () => {
      setDisplaySeconds(task.timerAccumulatedSeconds + Math.floor((Date.now() - startedMs) / 1000));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, task.timerStartedAt, task.timerAccumulatedSeconds]);

  // 心跳：让服务端知道「人还在」，间隔 30s
  useEffect(() => {
    if (!running) {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      return;
    }
    heartbeatRef.current = setInterval(() => {
      void touchTimerAction({ taskId: task.id, expectedVersion: task.timerVersion });
    }, HEARTBEAT_MS);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    };
  }, [running, task.id, task.timerVersion]);

  const onStart = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await startTimerAction({
        taskId: task.id,
        expectedVersion: task.timerVersion,
      });
      if (!result.ok) {
        setMessage(result.error);
        router.refresh();
        return;
      }
      router.refresh();
    });
  };

  const onPause = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await pauseTimerAction({
        taskId: task.id,
        expectedVersion: task.timerVersion,
      });
      if (!result.ok) {
        setMessage(result.error);
        router.refresh();
        return;
      }
      if (result.data.anomaly) {
        setMessage(result.data.anomalyReason ?? '本次计时被标记为异常');
      } else {
        setMessage(`已记录 ${result.data.netMinutes} 分钟`);
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className={[
          'tabular inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]',
          running
            ? 'border-blue-300 bg-blue-50 text-blue-800'
            : 'border-line bg-surfaceAlt text-inkMuted',
        ].join(' ')}
        title={running ? '计时中（服务端权威）' : '未在计时'}
      >
        <Icon name="clock" size={11} />
        {running ? formatClock(displaySeconds) : `${Math.round(displaySeconds / 60)} 分钟累计`}
      </span>

      {running ? (
        <Button variant="secondary" size="sm" onClick={onPause} disabled={pending}>
          <Icon name="pause" size={12} />
          {pending ? '处理中…' : '暂停'}
        </Button>
      ) : (
        <Button variant="primary" size="sm" onClick={onStart} disabled={pending}>
          <Icon name="play" size={12} />
          {pending ? '处理中…' : task.timerAccumulatedSeconds > 0 ? '继续计时' : '开始计时'}
        </Button>
      )}

      {message && <span className="text-[11px] text-inkMuted">{message}</span>}
    </div>
  );
}
