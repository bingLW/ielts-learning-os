'use server';

/**
 * 分项画像 Server Action。
 *
 * 依据必须属于同一技能的真实证据；方向不写就不写，绝不用平均分或猜测补全。
 */

import { revalidatePath } from 'next/cache';
import { stringifyArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { upsertSkillProfileSchema } from '@/lib/schema/profile';
import type { ActionResult } from '@/lib/types';

export async function upsertSkillProfileAction(
  raw: unknown,
): Promise<ActionResult<{ skill: string }>> {
  const parsed = upsertSkillProfileSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const input = parsed.data;
  const basis = input.evidenceBasis ?? [];

  if (basis.length > 0) {
    const records = await prisma.evidenceRecord.findMany({
      where: { id: { in: basis } },
      select: { id: true, skill: true },
    });
    if (records.length !== basis.length) {
      return fail('NOT_FOUND', '部分证据依据不存在，请刷新后重选');
    }
    const mismatched = records.find((record) => record.skill !== input.skill);
    if (mismatched) {
      return fail('PRECONDITION', '证据依据必须属于同一技能');
    }
  }

  const data = {
    direction: nullIfEmpty(input.direction),
    confidence: input.confidence,
    evidenceBasis: stringifyArray(basis),
    lastAssessedAt: nullIfEmpty(input.lastAssessedAt),
    reviewDueAt: nullIfEmpty(input.reviewDueAt),
    doNotInfer: nullIfEmpty(input.doNotInfer),
    note: nullIfEmpty(input.note),
  };

  await prisma.skillProfile.upsert({
    where: { skill: input.skill },
    create: { skill: input.skill, ...data },
    update: data,
  });

  revalidatePath('/profile');
  revalidatePath('/evidence');
  return ok({ skill: input.skill });
}
