/**
 * 阶段切换的**唯一写核心**（T09 口径 2 抽出，供两处 action 共用）。
 *
 * 为什么抽出来：`transitionStageAction`（手动切）与 `confirmStageTransitionAction`
 * （readiness 评审确认后切）都要做同一件事 —— 把旧 ACTIVE 标 COMPLETED、清残余
 * ACTIVE、置目标 ACTIVE、写 append-only `StageTransitionLog`。两份实现会分叉：
 * 一处改了「单 ACTIVE 保证」的写法、另一处没跟上，就会出现两个 ACTIVE 阶段。
 *
 * 事务客户端由调用方传入，本函数**不自己开事务**：`confirmStageTransitionAction`
 * 要在同一事务里先更新 `StageReadinessReview`（`userConfirmed`）再切阶段，两个写
 * 必须原子 —— 否则会出现「review 已确认、阶段没切」的半态。
 */

import { toBusinessDate } from '@/lib/date';
import type { Prisma } from '@prisma/client';

export interface ApplyStageTransitionInput {
  /** 即将被完成的阶段 code（写进 `StageTransitionLog.fromStageCode`，可为 null）。 */
  fromStageCode: string | null;
  /** 目标阶段 code（阶段表 `Stage.code` 唯一）。 */
  toStageCode: string;
  /** 切换原因（已 trim）。 */
  reason: string;
  /** 证据快照 JSON 文本（`StageTransitionLog.evidenceSnapshot`）。 */
  evidenceSnapshot: string | null;
}

/**
 * 在给定事务里执行「切阶段」三段 + 写日志，返回新建的 `StageTransitionLog`。
 *
 * 三段顺序不可调换（先完成旧的，再清残余，最后激活新的）：
 * 1. 当前唯一 ACTIVE → `COMPLETED`（写 `completedAt`）；
 * 2. `updateMany({ status: 'ACTIVE' })` → `COMPLETED`：清掉任何残余 ACTIVE。
 *    SQLite 没有部分唯一索引，这是「同一时刻只有一个 ACTIVE」的唯一正确做法；
 * 3. 目标 → `ACTIVE`（`startedAt` 无则用今天）。
 */
export async function applyStageTransition(
  tx: Prisma.TransactionClient,
  input: ApplyStageTransitionInput,
  timeZone: string,
): Promise<{ id: string }> {
  const todayStr = toBusinessDate(new Date(), timeZone);

  const current = await tx.stage.findFirst({ where: { status: 'ACTIVE' } });
  const target = await tx.stage.findUnique({ where: { code: input.toStageCode } });
  if (!target) {
    throw new Error(`applyStageTransition: 目标阶段 ${input.toStageCode} 不存在`);
  }

  // ① 旧 ACTIVE → COMPLETED
  if (current) {
    await tx.stage.update({
      where: { id: current.id },
      data: { status: 'COMPLETED', completedAt: todayStr },
    });
  }
  // ② 清残余 ACTIVE（含 ① 已处理的 current，幂等）
  await tx.stage.updateMany({
    where: { status: 'ACTIVE' },
    data: { status: 'COMPLETED', completedAt: todayStr },
  });
  // ③ 目标 → ACTIVE
  await tx.stage.update({
    where: { id: target.id },
    data: { status: 'ACTIVE', startedAt: target.startedAt ?? todayStr },
  });

  return tx.stageTransitionLog.create({
    data: {
      fromStageCode: input.fromStageCode,
      toStageCode: input.toStageCode,
      decidedBy: 'USER',
      reason: input.reason,
      evidenceSnapshot: input.evidenceSnapshot,
    },
  });
}
