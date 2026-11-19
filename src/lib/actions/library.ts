'use server';

/**
 * 方法论资料库 Server Actions。
 *
 * 只写 `ResourceReadingLog`；`ResourceReference` 的元数据由 seed 维护，
 * 页面没有编辑标题/链接/许可的入口（避免把原站信息抄错）。
 */

import { revalidatePath } from 'next/cache';
import { today } from '@/lib/date';
import { checkReadingLog, readingLastReadAt } from '@/lib/domain/library';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { updateReadingLogSchema } from '@/lib/schema/library';
import type { ActionResult } from '@/lib/types';

/** 更新阅读日志（状态 + 个人摘要 + 实践计划 + 关联证据）。 */
export async function updateReadingLogAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = updateReadingLogSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const input = parsed.data;
  const resource = await prisma.resourceReference.findUnique({
    where: { id: input.resourceId },
    select: { id: true, status: true },
  });
  if (!resource) return fail('NOT_FOUND', '资料不存在或已移除');
  if (resource.status !== 'ACTIVE') {
    return fail('PRECONDITION', '该资料已归档，不能再更新阅读状态');
  }

  if (input.appliedEvidenceId) {
    const evidence = await prisma.evidenceRecord.findUnique({
      where: { id: input.appliedEvidenceId },
      select: { id: true, archivedAt: true },
    });
    if (!evidence) return fail('NOT_FOUND', '关联证据不存在');
    if (evidence.archivedAt) return fail('PRECONDITION', '关联证据已归档，请换一条');
  }

  const personalSummary = nullIfEmpty(input.personalSummary);
  const plannedAction = nullIfEmpty(input.plannedAction);
  const gate = checkReadingLog({
    status: input.status,
    personalSummary,
    plannedAction,
    appliedEvidenceId: input.appliedEvidenceId ?? null,
  });
  if (!gate.ok) return fail('VALIDATION', gate.error);

  const lastReadAt = readingLastReadAt(input.status, today());

  await prisma.resourceReadingLog.upsert({
    where: { resourceId: resource.id },
    create: {
      resourceId: resource.id,
      status: input.status,
      personalSummary,
      plannedAction,
      appliedEvidenceId: input.appliedEvidenceId ?? null,
      lastReadAt,
    },
    update: {
      status: input.status,
      personalSummary,
      plannedAction,
      appliedEvidenceId: input.appliedEvidenceId ?? null,
      lastReadAt,
    },
  });

  revalidatePath('/library');
  return ok({ ok: true });
}
