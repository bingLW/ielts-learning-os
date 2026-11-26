'use server';

/**
 * 阶段验收与升级 Server Actions。
 *
 * 产品底线：系统**永不**自动切换阶段。这里只做两件事：
 * 1. 记录验收项的实际结果与判定（H1/H2 的数据来源）；
 * 2. 在用户主动确认后写 `StageTransitionLog`（时间 + 原因 + 证据快照）。
 */

import { revalidatePath } from 'next/cache';
import { getBusinessTimezone } from '@/lib/businessTime';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { transitionStageSchema, updateAcceptanceItemSchema } from '@/lib/schema/stage';
import { applyStageTransition } from '@/lib/services/stageTransition';
import type { ActionResult } from '@/lib/types';

/** 更新一条验收项。 */
export async function updateAcceptanceItemAction(
  raw: unknown,
): Promise<ActionResult<{ itemId: string; verdict: string }>> {
  const parsed = updateAcceptanceItemSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.stageAcceptanceItem.findUnique({
    where: { id: parsed.data.itemId },
  });
  if (!existing) return fail('NOT_FOUND', '验收项不存在');

  const verdict = parsed.data.verdict;
  await prisma.stageAcceptanceItem.update({
    where: { id: existing.id },
    data: {
      myResult: nullIfEmpty(parsed.data.myResult),
      evidence: nullIfEmpty(parsed.data.evidence),
      verdict,
      judgedAt:
        verdict === 'PENDING'
          ? null
          : (nullIfEmpty(parsed.data.judgedAt) ?? existing.judgedAt ?? null),
    },
  });

  revalidatePath('/stages');
  revalidatePath('/');
  return ok({ itemId: existing.id, verdict });
}

/**
 * 手动切换阶段。
 *
 * 事务内先 `updateMany({ status: 'ACTIVE' })` 清空旧 ACTIVE，再置新阶段 ——
 * SQLite 没有部分唯一索引，这是保证「同一时刻只有一个 ACTIVE」的唯一正确做法。
 */
export async function transitionStageAction(
  raw: unknown,
): Promise<ActionResult<{ logId: string; toStageCode: string }>> {
  const parsed = transitionStageSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const target = await prisma.stage.findUnique({ where: { id: parsed.data.toStageId } });
  if (!target) return fail('NOT_FOUND', '目标阶段不存在');

  const current = await prisma.stage.findFirst({ where: { status: 'ACTIVE' } });
  if (current && current.id === target.id) {
    return fail('PRECONDITION', '目标阶段已经是当前进行中的阶段');
  }

  const now = new Date();
  const timeZone = await getBusinessTimezone();

  const log = await prisma.$transaction((tx) =>
    applyStageTransition(tx, {
      fromStageCode: current?.code ?? null,
      toStageCode: target.code,
      reason: parsed.data.reason.trim(),
      evidenceSnapshot: stringify({
        at: now.toISOString(),
        fromStage: current?.code ?? null,
        toStage: target.code,
        note: '由用户手动确认；系统仅提供建议，未自动切换',
      }),
    }, timeZone),
  );

  revalidatePath('/');
  revalidatePath('/stages');
  revalidatePath('/plan');
  return ok({ logId: log.id, toStageCode: target.code });
}
