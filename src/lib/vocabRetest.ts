/**
 * 词汇维度延迟复测落库（服务端共用，不是 Server Action）。
 *
 * 与 `retestSchedule.ts` 的分工：
 * - 技能型复测由证据类型驱动（BASELINE / IMMEDIATE_RETEST / DELAYED_RETEST）；
 * - 词汇维度复测挂在词汇证据上，用 `VOCAB|<itemId>|<dimension>|…` 备注识别，
 *   因此不会和技能型复测互相覆盖，也不会把「已掌握」混成单一状态。
 */

import type { Prisma } from '@prisma/client';
import type { VocabDimension, VocabDimensionStatus } from '@/lib/constants';
import { toBusinessDate } from '@/lib/date';
import {
  buildVocabRetestPlan,
  isVocabRetestDue,
  vocabRetestNotePrefix,
} from '@/lib/domain/vocabRetest';
import { prisma } from '@/lib/prisma';

type Tx = Prisma.TransactionClient;

export interface VocabRetestSeed {
  evidenceId: string;
  itemId: string;
  lemma: string;
  dimension: VocabDimension;
  status: VocabDimensionStatus;
  createdAt: Date;
}

/**
 * 给一条词汇证据补排延迟复测，并用它结清同词同维度的到期复测。
 *
 * 返回 `{ completed, created }`：结清的到期排期数、新建的阶梯数。
 */
export async function ensureVocabularyRetest(
  tx: Tx,
  seed: VocabRetestSeed,
  timeZone: string,
): Promise<{ completed: number; created: number }> {
  const businessDate = toBusinessDate(seed.createdAt, timeZone);
  const prefix = vocabRetestNotePrefix(seed.itemId, seed.dimension);

  // 先结清到期排期，再排新阶梯：新一轮从这条证据的日期起算。
  const dueRows = await tx.retestSchedule.findMany({
    where: { note: { startsWith: prefix }, status: 'PENDING' },
    select: { id: true, dueDate: true },
  });
  const dueIds = dueRows
    .filter((row) => isVocabRetestDue(row.dueDate, businessDate))
    .map((row) => row.id);

  const completed =
    dueIds.length === 0
      ? 0
      : (
          await tx.retestSchedule.updateMany({
            where: { id: { in: dueIds }, status: 'PENDING' },
            data: {
              status: 'DONE',
              completedEvidenceId: seed.evidenceId,
              completedAt: seed.createdAt,
            },
          })
        ).count;

  const plan = buildVocabRetestPlan({
    itemId: seed.itemId,
    lemma: seed.lemma,
    dimension: seed.dimension,
    status: seed.status,
    baseDate: businessDate,
  });
  if (plan.length === 0) return { completed, created: 0 };

  const existing = await tx.retestSchedule.findMany({
    where: { idempotencyKey: { in: plan.map((step) => step.idempotencyKey) } },
    select: { idempotencyKey: true },
  });
  const existingKeys = new Set(existing.map((row) => row.idempotencyKey));
  const toCreate = plan.filter((step) => !existingKeys.has(step.idempotencyKey));
  if (toCreate.length === 0) return { completed, created: 0 };

  const result = await tx.retestSchedule.createMany({
    data: toCreate.map((step) => ({
      parentEvidenceId: seed.evidenceId,
      retestType: step.retestType,
      dueDate: step.dueDate,
      estMinutes: step.estMinutes,
      idempotencyKey: step.idempotencyKey,
      note: step.note,
    })),
  });
  return { completed, created: result.count };
}

/** 列出某词条某维度的复测排期（词详情页用）。 */
export async function listVocabRetests(itemId: string, dimension?: VocabDimension) {
  const prefix = dimension ? vocabRetestNotePrefix(itemId, dimension) : `VOCAB|${itemId}|`;
  return prisma.retestSchedule.findMany({
    where: { note: { startsWith: prefix } },
    orderBy: [{ dueDate: 'asc' }, { retestType: 'asc' }],
    select: {
      id: true,
      retestType: true,
      dueDate: true,
      status: true,
      note: true,
      completedAt: true,
    },
  });
}
