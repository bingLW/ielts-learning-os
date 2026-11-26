'use server';

/**
 * 错题本 Server Actions（T25）。
 *
 * 「从错题生成复习任务」也写同一张 `ReviewTask` 表（`targetType = 'MISTAKE'`），
 * 不另建调度器、不改写任何历史到期日。
 */

import { revalidatePath } from 'next/cache';
import {
  EST_MINUTES_BY_INTERVAL,
  MISTAKE_SOURCE_LABEL_ZH,
  REVIEW_INTERVAL_DAYS,
} from '@/lib/constants';
import { businessToday } from '@/lib/businessTime';
import { addDays, diffDays } from '@/lib/date';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import {
  archiveMistakeSchema,
  createMistakeSchema,
  generateMistakeReviewSchema,
  markMistakeMasteredSchema,
  updateMistakeSchema,
} from '@/lib/schema/mistake';
import type { ActionResult, MistakeSource } from '@/lib/types';

/** 统一刷新路径。 */
function revalidateMistakePaths(id?: string): void {
  revalidatePath('/mistakes');
  revalidatePath('/review');
  revalidatePath('/');
  if (id) revalidatePath(`/mistakes?focus=${id}`);
}

/**
 * 新增错题。
 *
 * 与架构 §5 的契约一致：**新增即排 D1 复习点**（PRD「错题自动排 D1」），
 * 到期日取 `max(today+1, 用户指定的 nextReviewAt)`，绝不落在过去。
 */
export async function createMistakeAction(
  raw: unknown,
): Promise<ActionResult<{ mistakeId: string; firstReviewDate: string }>> {
  const parsed = createMistakeSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const stage = await prisma.stage.findUnique({ where: { id: input.stageId } });
  if (!stage) return fail('NOT_FOUND', '阶段不存在');

  const todayStr = await businessToday();
  const natural = addDays(todayStr, REVIEW_INTERVAL_DAYS.D1);
  const explicit = nullIfEmpty(input.nextReviewAt);
  const candidate = explicit ?? natural;
  const firstReviewDate = diffDays(todayStr, candidate) < 0 ? todayStr : candidate;

  const created = await prisma.$transaction(async (tx) => {
    const mistake = await tx.mistake.create({
      data: {
        stageId: input.stageId,
        sourceType: input.sourceType,
        studyRecordId: nullIfEmpty(input.studyRecordId),
        originalQuestion: input.originalQuestion.trim(),
        myAnswer: nullIfEmpty(input.myAnswer),
        correctAnswer: input.correctAnswer.trim(),
        errorReason: input.errorReason.trim(),
        knowledgePoint: input.knowledgePoint.trim(),
        errorCategory: input.errorCategory,
        ieltsErrorCategory: nullIfEmpty(input.ieltsErrorCategory),
        nextReviewAt: firstReviewDate,
      },
    });

    await tx.reviewTask.create({
      data: {
        targetType: 'MISTAKE',
        targetId: mistake.id,
        targetLabel: `${MISTAKE_SOURCE_LABEL_ZH[input.sourceType as MistakeSource] ?? input.sourceType} · ${input.knowledgePoint.trim()}`,
        knowledgePoint: input.knowledgePoint.trim(),
        intervalCode: 'D1',
        dueDate: firstReviewDate,
        estMinutes: EST_MINUTES_BY_INTERVAL.D1,
      },
    });

    return mistake;
  });

  revalidateMistakePaths();
  return ok({ mistakeId: created.id, firstReviewDate });
}

/** 编辑错题（不删历史，只改正文）。 */
export async function updateMistakeAction(
  raw: unknown,
): Promise<ActionResult<{ mistakeId: string }>> {
  const parsed = updateMistakeSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const existing = await prisma.mistake.findUnique({ where: { id: input.id } });
  if (!existing) return fail('NOT_FOUND', '错题不存在或已被删除');

  await prisma.mistake.update({
    where: { id: existing.id },
    data: {
      stageId: input.stageId,
      sourceType: input.sourceType,
      studyRecordId: nullIfEmpty(input.studyRecordId),
      originalQuestion: input.originalQuestion.trim(),
      myAnswer: nullIfEmpty(input.myAnswer),
      correctAnswer: input.correctAnswer.trim(),
      errorReason: input.errorReason.trim(),
      knowledgePoint: input.knowledgePoint.trim(),
      errorCategory: input.errorCategory,
      ieltsErrorCategory: nullIfEmpty(input.ieltsErrorCategory),
      nextReviewAt: nullIfEmpty(input.nextReviewAt),
    },
  });

  revalidateMistakePaths(existing.id);
  return ok({ mistakeId: existing.id });
}

/** 标记 / 取消「已掌握」。标记掌握时把待复习的错题任务一并跳过。 */
export async function markMistakeMasteredAction(
  raw: unknown,
): Promise<ActionResult<{ id: string; isMastered: boolean }>> {
  const parsed = markMistakeMasteredSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.mistake.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return fail('NOT_FOUND', '错题不存在或已被删除');

  await prisma.$transaction(async (tx) => {
    await tx.mistake.update({
      where: { id: existing.id },
      data: { isMastered: parsed.data.mastered },
    });

    if (parsed.data.mastered) {
      await tx.reviewTask.updateMany({
        where: { targetType: 'MISTAKE', targetId: existing.id, status: 'PENDING' },
        data: { status: 'SKIPPED', skippedReason: '错题已标记掌握' },
      });
    }
  });

  revalidateMistakePaths(existing.id);
  return ok({ id: existing.id, isMastered: parsed.data.mastered });
}

/** 归档错题（软删除）+ 跳过其待复习任务。 */
export async function archiveMistakeAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = archiveMistakeSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.mistake.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return fail('NOT_FOUND', '错题不存在或已被删除');
  if (existing.archivedAt) return ok({ ok: true });

  await prisma.$transaction(async (tx) => {
    await tx.mistake.update({ where: { id: existing.id }, data: { archivedAt: new Date() } });
    await tx.reviewTask.updateMany({
      where: { targetType: 'MISTAKE', targetId: existing.id, status: 'PENDING' },
      data: { status: 'SKIPPED', skippedReason: '错题已归档' },
    });
  });

  revalidateMistakePaths(existing.id);
  return ok({ ok: true });
}

/**
 * 从错题生成复习任务。
 *
 * 已掌握的错题会被跳过（不再占用复习额度），返回值里如实报告跳过条数。
 */
export async function generateMistakeReviewAction(
  raw: unknown,
): Promise<ActionResult<{ created: number; skipped: number; dueDate: string }>> {
  const parsed = generateMistakeReviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const intervalDays = parsed.data.intervalDays ?? REVIEW_INTERVAL_DAYS.MANUAL;
  const dueDate = addDays(await businessToday(), intervalDays);

  const mistakes = await prisma.mistake.findMany({
    where: { id: { in: parsed.data.ids }, archivedAt: null },
    select: {
      id: true,
      knowledgePoint: true,
      isMastered: true,
      sourceType: true,
      originalQuestion: true,
    },
  });
  if (mistakes.length === 0) return fail('NOT_FOUND', '所选错题不存在或已归档');

  const existing = await prisma.reviewTask.findMany({
    where: {
      targetType: 'MISTAKE',
      targetId: { in: mistakes.map((item) => item.id) },
      status: 'PENDING',
    },
    select: { targetId: true },
  });
  const pendingSet = new Set(existing.map((item) => item.targetId));

  let created = 0;
  let skipped = 0;

  for (const mistake of mistakes) {
    if (mistake.isMastered || pendingSet.has(mistake.id)) {
      skipped += 1;
      continue;
    }

    const label = `${MISTAKE_SOURCE_LABEL_ZH[mistake.sourceType as MistakeSource] ?? mistake.sourceType} · ${mistake.knowledgePoint}`;
    // eslint-disable-next-line no-await-in-loop -- 每条错题独立写一行，量级 ≤200
    await prisma.reviewTask.create({
      data: {
        targetType: 'MISTAKE',
        targetId: mistake.id,
        targetLabel: label,
        knowledgePoint: mistake.knowledgePoint,
        intervalCode: 'MANUAL',
        dueDate,
        estMinutes: EST_MINUTES_BY_INTERVAL.MANUAL,
      },
    });
    // eslint-disable-next-line no-await-in-loop -- 与上一行同一条错题，保持顺序
    await prisma.mistake.update({
      where: { id: mistake.id },
      data: { nextReviewAt: dueDate },
    });
    created += 1;
  }

  revalidateMistakePaths();
  return ok({ created, skipped, dueDate });
}
