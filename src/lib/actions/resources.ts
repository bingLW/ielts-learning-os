'use server';

/**
 * 资源库 Server Actions。
 *
 * 代码中不出现任何资源名字面量 —— 资源是纯数据，8 类初始资源由 `prisma/seed.ts` 写入。
 */

import { revalidatePath } from 'next/cache';
import { stringifyArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { archiveResourceSchema, upsertResourceSchema } from '@/lib/schema/resource';
import type { ActionResult } from '@/lib/types';

/** 新增 / 编辑资源。 */
export async function upsertResourceAction(
  raw: unknown,
): Promise<ActionResult<{ resourceId: string }>> {
  const parsed = upsertResourceSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const input = parsed.data;
  const data = {
    name: input.name.trim(),
    subject: input.subject,
    type: input.type,
    applicableStages: stringifyArray(input.applicableStages),
    version: nullIfEmpty(input.version),
    totalUnits: input.totalUnits ?? null,
    currentUnit: input.currentUnit ?? null,
    startDate: nullIfEmpty(input.startDate),
    finishDate: nullIfEmpty(input.finishDate),
    url: nullIfEmpty(input.url),
    note: nullIfEmpty(input.note),
    isPrimary: input.isPrimary ?? false,
  };

  if (input.id) {
    const existing = await prisma.resource.findUnique({ where: { id: input.id } });
    if (!existing) return fail('NOT_FOUND', '资源不存在或已被删除');
    await prisma.resource.update({ where: { id: input.id }, data });
    revalidatePath('/resources');
    revalidatePath('/settings');
    revalidatePath('/records');
    revalidatePath('/plan');
    return ok({ resourceId: input.id });
  }

  const created = await prisma.resource.create({ data });
  revalidatePath('/resources');
  revalidatePath('/settings');
  revalidatePath('/records');
  revalidatePath('/plan');
  return ok({ resourceId: created.id });
}

/** 归档资源（软删除）。已挂任务/记录的资源不会被物理删除。 */
export async function archiveResourceAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = archiveResourceSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.resource.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return fail('NOT_FOUND', '资源不存在或已被删除');
  if (existing.archivedAt) return ok({ ok: true });

  await prisma.resource.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
  });

  revalidatePath('/resources');
  revalidatePath('/settings');
  revalidatePath('/records');
  revalidatePath('/plan');
  return ok({ ok: true });
}
