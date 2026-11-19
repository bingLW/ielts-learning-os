'use server';

/**
 * 能力评估录入 Action（v2.0 P4）。
 *
 * 两条独立证据链，分别落 `SkillAssessment`（CEFR）与 `IeltsAssessment`（雅思）。
 * 二者**不互相写、不互相读** —— 成绩独立性由结构保证（SOP v2 §2）。
 */

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import {
  createIeltsAssessmentSchema,
  createSkillAssessmentSchema,
  deleteAssessmentSchema,
} from '@/lib/schema/assessment';
import type { ActionResult } from '@/lib/types';

/** 新建 CEFR 能力评估。 */
export async function createSkillAssessmentAction(
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createSkillAssessmentSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const data = parsed.data;
  const record = await prisma.skillAssessment.create({
    data: {
      skill: data.skill,
      cefrLevel: data.cefrLevel,
      assessmentType: data.assessmentType,
      score: nullIfEmpty(data.score),
      assessDate: data.assessDate,
      assessor: data.assessor,
      confidence: data.confidence,
      evidenceId: nullIfEmpty(data.evidenceId),
      note: nullIfEmpty(data.note),
    },
  });

  revalidatePath('/general');
  revalidatePath('/stages');
  revalidatePath('/');
  return ok({ id: record.id });
}

/** 新建雅思成绩。 */
export async function createIeltsAssessmentAction(
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createIeltsAssessmentSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const data = parsed.data;
  const record = await prisma.ieltsAssessment.create({
    data: {
      testDate: data.testDate,
      testType: data.testType,
      overallBand: data.overallBand,
      listeningBand: data.listeningBand ?? null,
      readingBand: data.readingBand ?? null,
      writingBand: data.writingBand ?? null,
      speakingBand: data.speakingBand ?? null,
      source: nullIfEmpty(data.source),
      notes: nullIfEmpty(data.notes),
    },
  });

  revalidatePath('/ielts');
  revalidatePath('/stages');
  revalidatePath('/');
  return ok({ id: record.id });
}

/** 删除评估记录（硬删除；评估是「样本」，删错可重录，无需软删除）。 */
export async function deleteAssessmentAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = deleteAssessmentSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { id, kind } = parsed.data;
  if (kind === 'SKILL') {
    const existing = await prisma.skillAssessment.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return fail('NOT_FOUND', '评估记录不存在或已被删除');
    await prisma.skillAssessment.delete({ where: { id } });
    revalidatePath('/general');
  } else {
    const existing = await prisma.ieltsAssessment.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return fail('NOT_FOUND', '成绩记录不存在或已被删除');
    await prisma.ieltsAssessment.delete({ where: { id } });
    revalidatePath('/ielts');
  }

  revalidatePath('/stages');
  revalidatePath('/');
  return ok({ ok: true });
}
