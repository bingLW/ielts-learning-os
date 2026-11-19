'use server';

/**
 * 计时器 Server Actions —— 全部是 `timerService` 的薄封装。
 *
 * 客户端只能传 `taskId` + `expectedVersion`：
 * 时长由服务端时钟计算，客户端拿不到也不能伪造 elapsed。
 */

import { revalidatePath } from 'next/cache';
import { fail, failValidation, ok } from '@/lib/result';
import { pauseTimerSchema, startTimerSchema, touchTimerSchema } from '@/lib/schema/plan';
import {
  closeRunningSession,
  startTimer,
  touchTimer,
  type TimerStateDto,
} from '@/lib/services/timerService';
import type { ActionResult } from '@/lib/types';

/** 开始计时（幂等短路 + CAS）。 */
export async function startTimerAction(raw: unknown): Promise<ActionResult<TimerStateDto>> {
  const parsed = startTimerSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await startTimer(parsed.data.taskId, parsed.data.expectedVersion);
  if (!result.ok) return fail(result.code, result.error);

  revalidatePath('/plan');
  return ok(result.state);
}

/** 心跳：只刷 `timerLastActiveAt`，不增版本（否则会误伤其他标签页）。 */
export async function touchTimerAction(
  raw: unknown,
): Promise<ActionResult<{ timerVersion: number }>> {
  const parsed = touchTimerSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await touchTimer(parsed.data.taskId, parsed.data.expectedVersion);
  if (!result.ok) return fail(result.code, result.error);
  return ok({ timerVersion: result.timerVersion });
}

/** 暂停计时：生成 1 条 `StudySession` + 跨零点 `DaySplit`。 */
export async function pauseTimerAction(
  raw: unknown,
): Promise<
  ActionResult<{
    state: TimerStateDto;
    sessionId: string | null;
    netMinutes: number;
    idleMinutes: number;
    anomaly: boolean;
    anomalyReason: string | null;
    idlePrompt: boolean;
  }>
> {
  const parsed = pauseTimerSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await closeRunningSession(parsed.data.taskId, parsed.data.expectedVersion, 'PAUSED');
  if (!result.ok) return fail(result.code, result.error);

  revalidatePath('/plan');
  revalidatePath('/');
  return ok({
    state: result.state,
    sessionId: result.sessionId,
    netMinutes: result.netMinutes,
    idleMinutes: result.idleMinutes,
    anomaly: result.anomaly,
    anomalyReason: result.anomalyReason,
    idlePrompt: result.idlePrompt,
  });
}
