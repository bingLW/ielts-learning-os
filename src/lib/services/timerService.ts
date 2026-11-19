/**
 * 计时器服务层：服务端权威时钟 + 乐观锁（CAS）。
 *
 * 这是全站**唯一**能写 `timerStatus / timerStartedAt / timerAccumulatedSeconds /
 * timerVersion` 与 `StudySession` 的地方。
 *
 * 三条铁律：
 * 1. 客户端只传 `expectedVersion`，**绝不传 elapsed**（否则改系统时间就能刷时长）；
 * 2. `start` 幂等短路：同版本重放返回同一状态，不新建 session；
 * 3. `pause` 用 `updateMany({ where: { id, timerVersion } })` 做 CAS，`count === 0` 即冲突 ——
 *    这是防「双标签页双计时 / 重复 session」的唯一正确写法。
 */

import { IDLE_GAP_MINUTES, TIMER_MIN_VALID_SECONDS } from '@/lib/constants';
import { splitAcrossMidnight } from '@/lib/date';
import { clampCountRatio, sessionNet } from '@/lib/domain/duration';
import { prisma } from '@/lib/prisma';
import type { TerminatedReason, TimerStatus } from '@/lib/types';

const MS_PER_MINUTE = 60_000;

/** 计时状态 DTO（可序列化）。 */
export interface TimerStateDto {
  timerStatus: TimerStatus;
  timerStartedAt: string | null;
  timerAccumulatedSeconds: number;
  timerVersion: number;
}

/** 冲突哨兵：在事务内抛出以回滚，由外层转成 `CONFLICT` 返回值。 */
export class TimerConflictError extends Error {
  constructor(message = '计时器状态已变化') {
    super(message);
    this.name = 'TimerConflictError';
  }
}

export type TimerServiceFailure = {
  ok: false;
  code: 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION';
  error: string;
};

/** 把库中任务映射成计时状态 DTO。 */
export function toTimerState(task: {
  timerStatus: string;
  timerStartedAt: Date | null;
  timerAccumulatedSeconds: number;
  timerVersion: number;
}): TimerStateDto {
  return {
    timerStatus: task.timerStatus as TimerStatus,
    timerStartedAt: task.timerStartedAt ? task.timerStartedAt.toISOString() : null,
    timerAccumulatedSeconds: task.timerAccumulatedSeconds,
    timerVersion: task.timerVersion,
  };
}

/**
 * 开始计时。
 *
 * 幂等语义：如果任务已在 RUNNING 且版本一致 → 直接返回当前状态（重放安全）；
 * 版本不一致 → 说明另一个标签页先动了，返回 CONFLICT 让客户端拉取权威状态。
 */
export async function startTimer(
  taskId: string,
  expectedVersion: number,
): Promise<{ ok: true; state: TimerStateDto } | TimerServiceFailure> {
  const task = await prisma.planTask.findUnique({ where: { id: taskId } });
  if (!task) return { ok: false, code: 'NOT_FOUND', error: '任务不存在或已被删除' };

  if (task.timerStatus === 'RUNNING') {
    if (task.timerVersion === expectedVersion) {
      // 同一请求重放：返回同一结果，不新建 session
      return { ok: true, state: toTimerState(task) };
    }
    return {
      ok: false,
      code: 'CONFLICT',
      error: '该任务已在其他页面开始计时，已同步为服务端状态',
    };
  }

  const now = new Date();
  const updated = await prisma.planTask.updateMany({
    where: { id: taskId, timerVersion: expectedVersion },
    data: {
      timerStatus: 'RUNNING',
      timerStartedAt: now,
      timerLastActiveAt: now,
      timerVersion: expectedVersion + 1,
      status: task.status === 'TODO' ? 'IN_PROGRESS' : task.status,
      statusChangedAt: task.status === 'TODO' ? now : task.statusChangedAt,
    },
  });

  if (updated.count === 0) {
    return { ok: false, code: 'CONFLICT', error: '计时器版本已变化，请刷新后重试' };
  }

  const fresh = await prisma.planTask.findUnique({ where: { id: taskId } });
  if (!fresh) return { ok: false, code: 'NOT_FOUND', error: '任务不存在或已被删除' };
  return { ok: true, state: toTimerState(fresh) };
}

/**
 * 刷新「最后活跃时间」。只用于空闲判定，**不增加版本号**（否则每次心跳都会让
 * 另一个标签页的 pause 变成冲突）。
 */
export async function touchTimer(
  taskId: string,
  expectedVersion: number,
): Promise<{ ok: true; timerVersion: number } | TimerServiceFailure> {
  const updated = await prisma.planTask.updateMany({
    where: { id: taskId, timerStatus: 'RUNNING', timerVersion: expectedVersion },
    data: { timerLastActiveAt: new Date() },
  });
  if (updated.count === 0) {
    return { ok: false, code: 'CONFLICT', error: '计时器已停止或版本已变化' };
  }
  return { ok: true, timerVersion: expectedVersion };
}

/** 关闭计时的结果。 */
export type CloseSessionResult =
  | {
      ok: true;
      state: TimerStateDto;
      sessionId: string | null;
      netMinutes: number;
      idleMinutes: number;
      elapsedSeconds: number;
      anomaly: boolean;
      anomalyReason: string | null;
      idlePrompt: boolean;
    }
  | TimerServiceFailure;

/** 单段计时拆分的自然日归属（`sessionDate` 取占比最大的那天）。 */
function dominantDate(splits: { date: string; minutes: number }[], fallback: string): string {
  if (splits.length === 0) return fallback;
  return [...splits].sort((a, b) => b.minutes - a.minutes)[0].date;
}

/**
 * 结束当前计时段：算出净时长、落一条 `StudySession` + 跨零点 `DaySplit`，并 CAS 推进版本。
 *
 * @param expectedVersion 客户端持有的版本；传 `task.timerVersion` 表示「就地关闭」
 */
export async function closeRunningSession(
  taskId: string,
  expectedVersion: number,
  terminatedReason: TerminatedReason = 'PAUSED',
): Promise<CloseSessionResult> {
  const task = await prisma.planTask.findUnique({ where: { id: taskId } });
  if (!task) return { ok: false, code: 'NOT_FOUND', error: '任务不存在或已被删除' };

  // 幂等：已经是暂停/停止态且版本一致 → 直接返回，不再生成 session
  if (task.timerStatus !== 'RUNNING') {
    if (task.timerVersion === expectedVersion) {
      return {
        ok: true,
        state: toTimerState(task),
        sessionId: null,
        netMinutes: 0,
        idleMinutes: 0,
        elapsedSeconds: 0,
        anomaly: false,
        anomalyReason: null,
        idlePrompt: false,
      };
    }
    return { ok: false, code: 'CONFLICT', error: '计时器当前未在运行，且版本已变化' };
  }

  const now = new Date();
  const startedAt = task.timerStartedAt ?? now;
  const elapsedMs = Math.max(0, now.getTime() - startedAt.getTime());
  const elapsedSeconds = Math.round(elapsedMs / 1000);

  // 空闲判定：最后一次心跳距今超过 30 分钟 → 该区间计入 idle，不计 active
  const lastActive = task.timerLastActiveAt ?? startedAt;
  const gapMinutes = Math.max(0, Math.round((now.getTime() - lastActive.getTime()) / MS_PER_MINUTE));
  const idleMinutes = gapMinutes > IDLE_GAP_MINUTES ? gapMinutes : 0;

  const rawActiveMinutes = Math.max(0, Math.round(elapsedSeconds / 60) - idleMinutes);
  const net = sessionNet({
    activeMinutes: rawActiveMinutes,
    plannedMinutes: task.plannedMinutes,
    startedAt: startedAt.toISOString(),
    endedAt: now.toISOString(),
    idleMinutes,
  });

  const isTooShort = elapsedSeconds < TIMER_MIN_VALID_SECONDS;
  const anomaly = net.anomaly || idleMinutes > 0 || isTooShort;
  const anomalyReason = isTooShort
    ? '计时不足 1 分钟，按误触处理'
    : net.reason ?? (idleMinutes > 0 ? `中断 ${idleMinutes} 分钟未操作，已剔除` : null);
  const effectiveReason: TerminatedReason = isTooShort ? 'ABANDONED' : terminatedReason;

  // 写入（事务内，避免 session 与 task 快照不一致）
  let sessionId: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      const cas = await tx.planTask.updateMany({
        where: { id: taskId, timerVersion: expectedVersion, timerStatus: 'RUNNING' },
        data: {
          timerStatus: 'PAUSED',
          timerStartedAt: null,
          timerAccumulatedSeconds: task.timerAccumulatedSeconds + elapsedSeconds,
          timerVersion: expectedVersion + 1,
          timerLastActiveAt: now,
          actualMinutes: { increment: net.netMinutes },
        },
      });
      if (cas.count === 0) throw new TimerConflictError();

      if (isTooShort) return;

      const splits = splitAcrossMidnight(startedAt.toISOString(), net.netMinutes);
      const fromDate = splits[0]?.date ?? startedAt.toISOString().slice(0, 10);
      const session = await tx.studySession.create({
        data: {
          taskId,
          startedAt,
          endedAt: now,
          activeMinutes: net.netMinutes,
          idleMinutes,
          countRatio: clampCountRatio(net.netMinutes, task.plannedMinutes),
          anomalyFlag: anomaly,
          anomalyReason,
          terminatedReason: effectiveReason,
          sessionDate: dominantDate(splits, fromDate),
          // v2.0：从任务快照复制轨道与四技能粒度。
          // 为什么在这一刻快照而不是聚合时 join：任务日后被改 module/track 时
          // （例如把一条任务从通用英语改挂雅思），历史 session 的归属不该跟着变 ——
          // 否则上月的数据会被本月的编辑改写。快照是唯一能保证历史稳定的做法。
          track: task.track,
          skill: task.primarySkill,
        },
      });
      sessionId = session.id;

      if (splits.length > 0) {
        await tx.studySessionDaySplit.createMany({
          data: splits.map((split) => ({
            sessionId: session.id,
            date: split.date,
            minutes: split.minutes,
          })),
        });
      }
    });
  } catch (error) {
    if (error instanceof TimerConflictError) {
      return {
        ok: false,
        code: 'CONFLICT',
        error: '计时器已被其他页面修改，请刷新后重试',
      };
    }
    throw error;
  }

  const fresh = await prisma.planTask.findUnique({ where: { id: taskId } });
  if (!fresh) return { ok: false, code: 'NOT_FOUND', error: '任务不存在或已被删除' };

  return {
    ok: true,
    state: toTimerState(fresh),
    sessionId,
    netMinutes: net.netMinutes,
    idleMinutes,
    elapsedSeconds,
    anomaly,
    anomalyReason,
    // 中断后需要让用户三选一：继续 / 部分完成 / 作废
    idlePrompt: idleMinutes > 0 || isTooShort,
  };
}
