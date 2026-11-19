/**
 * 复测链生成（服务端共用，不是 Server Action）。
 *
 * 规则：
 * - 只为会开启/延续证据链的类型排复测（见 RETEST_AUTO_PARENT_TYPES）；
 * - 同一条证据链只维护一条复测阶梯：链根已有排期就跳过，避免「基线 + 辅助版」各排一套；
 * - 幂等键 = `父证据ID:复测类型:到期日`，重复生成不会产生新行。
 */

import type { Prisma } from '@prisma/client';
import { RETEST_AUTO_PARENT_TYPES } from './constants';
import { toBusinessDate } from './date';
import { buildRetestPlan } from './domain/evidence';
import type { LearningEvidenceType } from './types';

type Tx = Prisma.TransactionClient;

export interface RetestSeedEvidence {
  id: string;
  skill: string;
  evidenceType: string;
  chainRootId: string | null;
  createdAt: Date;
}

/**
 * 给一条新证据补排复测；返回本次新建的排期数。
 *
 * `rootId` 取链根：基线/独立记录的链根就是自己；派生记录沿用父链的链根。
 */
export async function ensureRetestChain(
  tx: Tx,
  evidence: RetestSeedEvidence,
): Promise<number> {
  if (!RETEST_AUTO_PARENT_TYPES.includes(evidence.evidenceType as LearningEvidenceType)) {
    return 0;
  }

  const rootId = evidence.chainRootId ?? evidence.id;
  const existing = await tx.retestSchedule.findFirst({
    where: { parentEvidenceId: rootId },
    select: { id: true },
  });
  if (existing) return 0;

  const baseDate = toBusinessDate(evidence.createdAt);
  const plan = buildRetestPlan(rootId, evidence.evidenceType as LearningEvidenceType, baseDate);
  if (plan.length === 0) return 0;

  const result = await tx.retestSchedule.createMany({
    data: plan.map((step) => ({
      parentEvidenceId: rootId,
      retestType: step.retestType,
      dueDate: step.dueDate,
      estMinutes: step.estMinutes,
      idempotencyKey: step.idempotencyKey,
    })),
  });
  return result.count;
}
