'use server';

/**
 * AI 使用日志 Server Actions。
 *
 * 日志是防自欺的记录：A4 永远标记为非独立；不提供删除入口。
 */

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { createAiUsageSchema } from '@/lib/schema/aiUsage';
import type { AIActionType, ActionResult, AssistanceLevel } from '@/lib/types';

export async function createAiUsageAction(
  raw: unknown,
): Promise<ActionResult<{ usageId: string }>> {
  const parsed = createAiUsageSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  if (input.evidenceId) {
    const evidence = await prisma.evidenceRecord.findUnique({
      where: { id: input.evidenceId },
      select: { id: true, archivedAt: true },
    });
    if (!evidence) return fail('NOT_FOUND', '关联证据不存在或已被删除');
    if (evidence.archivedAt) return fail('PRECONDITION', '关联证据已归档，不能挂新的 AI 使用记录');
  }

  const created = await prisma.aIUsageRecord.create({
    data: {
      toolName: input.toolName,
      modelVersion: nullIfEmpty(input.modelVersion),
      assistanceLevel: input.assistanceLevel as AssistanceLevel,
      actionType: input.actionType as AIActionType,
      purpose: nullIfEmpty(input.purpose),
      inputRef: nullIfEmpty(input.inputRef),
      outputRef: nullIfEmpty(input.outputRef),
      adoptedOrRejected: input.adoptedOrRejected,
      evidenceId: input.evidenceId ?? null,
    },
    select: { id: true },
  });

  revalidatePath('/coach');
  return ok({ usageId: created.id });
}
