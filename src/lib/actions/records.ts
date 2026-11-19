'use server';

/**
 * 学习记录 Server Actions。
 *
 * 三件事必须在这里保证：
 * 1. G2 —— 产出/问题至少一项（schema 已拦，这里再防御一次）；
 * 2. 编辑不改 `createdAt`，且逐字段写 `RecordRevision`；
 * 3. 删除是软删除（写 `archivedAt`），历史与修订记录都保留。
 */

import { revalidatePath } from 'next/cache';
import { SKILL_TO_PRIMARY, SKILL_TRACK } from '@/lib/constants';
import { stringify, stringifyArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import {
  archiveRecordSchema,
  createRecordSchema,
  updateRecordSchema,
  type CreateRecordInput,
} from '@/lib/schema/record';
import type { ActionResult, LearningTrack, PrimarySkill } from '@/lib/types';
import { writeFieldRevisions, type RecordSnapshot } from './recordRevision';

/**
 * 把 schema 输出摊平成 Prisma 写入数据。
 *
 * v2.0：`track` / `primarySkill` 未显式给出时按 `skill` 推导。
 * 推导而非留空，是因为聚合口径依赖这两个快照非空 ——
 * 留空会让一条记录既不属于任何轨道也不属于四技能，静默消失在所有统计之外。
 */
function toRecordData(input: CreateRecordInput) {
  return {
    stageId: input.stageId,
    taskId: input.taskId ?? null,
    recordDate: input.recordDate,
    skill: input.skill,
    resourceId: input.resourceId ?? null,
    chapter: nullIfEmpty(input.chapter),
    content: input.content.trim(),
    plannedMinutes: input.plannedMinutes,
    actualMinutes: input.actualMinutes,
    status: input.status,
    totalQuestions: input.totalQuestions,
    correctQuestions: input.correctQuestions,
    difficulty: input.difficulty ?? null,
    outputText: nullIfEmpty(input.outputText),
    problemText: nullIfEmpty(input.problemText),
    errorTypes: input.errorTypes && input.errorTypes.length > 0 ? stringifyArray(input.errorTypes) : null,
    nextReviewDate: nullIfEmpty(input.nextReviewDate),
    ext: input.ext && Object.keys(input.ext).length > 0 ? stringify(input.ext) : null,
    track: (input.track ?? SKILL_TRACK[input.skill]) as LearningTrack,
    primarySkill: (input.primarySkill ?? SKILL_TO_PRIMARY[input.skill]) as PrimarySkill,
  };
}

/** 新建记录。 */
export async function createStudyRecordAction(
  raw: unknown,
): Promise<ActionResult<{ recordId: string }>> {
  const parsed = createRecordSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const record = await prisma.studyRecord.create({ data: toRecordData(parsed.data) });

  revalidatePath('/records');
  revalidatePath('/');
  revalidatePath('/plan');
  return ok({ recordId: record.id });
}

/** 编辑记录（字段级 diff 留痕，`createdAt` 不变）。 */
export async function updateStudyRecordAction(
  raw: unknown,
): Promise<ActionResult<{ recordId: string; changedFields: number }>> {
  const parsed = updateRecordSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.studyRecord.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return fail('NOT_FOUND', '记录不存在或已被删除');

  const nextData = toRecordData(parsed.data);
  let changedFields = 0;

  await prisma.$transaction(async (tx) => {
    changedFields = await writeFieldRevisions(
      tx,
      existing.id,
      existing as unknown as RecordSnapshot,
      nextData as unknown as RecordSnapshot,
    );
    await tx.studyRecord.update({ where: { id: existing.id }, data: nextData });
  });

  revalidatePath('/records');
  revalidatePath(`/records/${existing.id}`);
  revalidatePath('/');
  return ok({ recordId: existing.id, changedFields });
}

/** 软删除（归档）。 */
export async function archiveStudyRecordAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = archiveRecordSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.studyRecord.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return fail('NOT_FOUND', '记录不存在或已被删除');
  if (existing.archivedAt) return ok({ ok: true });

  await prisma.studyRecord.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
  });

  revalidatePath('/records');
  revalidatePath('/');
  return ok({ ok: true });
}
