'use server';

/**
 * Evidence Core Server Actions。
 *
 * 原始样本不可覆盖：这里没有 update 文本的入口，修订只能新建记录并挂 parentEvidenceId。
 * 删除 = 软删除（archivedAt），历史版本链保留。
 */

import { revalidatePath } from 'next/cache';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { ensureRetestChain } from '@/lib/retestSchedule';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { archiveEvidenceSchema, createEvidenceSchema } from '@/lib/schema/evidence';
import { parseEvidenceCondition } from '@/lib/domain/evidence';
import { checkRetestEvidence, checkTransferContext } from '@/lib/domain/retest';
import { toUtcInstant } from '@/lib/date';
import type { ActionResult, EvidenceSkill, RetestType } from '@/lib/types';

function revalidateEvidencePages() {
  revalidatePath('/evidence');
  revalidatePath('/retest');
  revalidatePath('/');
}

/** 新建证据；作为某条证据的下一版本时必须显式挂 parentEvidenceId。 */
export async function createEvidenceAction(
  raw: unknown,
): Promise<ActionResult<{ evidenceId: string }>> {
  const parsed = createEvidenceSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const input = parsed.data;

  let chainRootId: string | null = null;
  let parentEvidenceId = input.parentEvidenceId ?? null;
  let retestScheduleId: string | null = null;

  if (input.retestScheduleId) {
    const schedule = await prisma.retestSchedule.findUnique({
      where: { id: input.retestScheduleId },
      include: {
        parent: {
          select: {
            id: true,
            skill: true,
            archivedAt: true,
            chainRootId: true,
            conditionJson: true,
            taskId: true,
          },
        },
      },
    });
    if (!schedule) return fail('NOT_FOUND', '复测排期不存在');
    if (schedule.status !== 'PENDING') return fail('CONFLICT', '该复测已完成或已跳过');
    if (schedule.parent.archivedAt) {
      return fail('PRECONDITION', '父证据已归档，无法完成这次复测');
    }

    const check = checkRetestEvidence({
      retestType: schedule.retestType as RetestType,
      parentSkill: schedule.parent.skill as EvidenceSkill,
      evidenceSkill: input.skill,
      evidenceType: input.evidenceType,
      assistanceLevel: input.assistanceLevel ?? 'A0',
    });
    if (!check.ok) return fail('VALIDATION', check.error);

    if (schedule.retestType === 'TRANSFER') {
      const parentCondition = parseEvidenceCondition(schedule.parent.conditionJson);
      const transfer = checkTransferContext(
        {
          prompt: parentCondition?.prompt ?? null,
          materialSource: parentCondition?.materialSource ?? null,
          taskId: schedule.parent.taskId,
        },
        {
          prompt: input.condition?.prompt ?? null,
          materialSource: input.condition?.materialSource ?? null,
          taskId: input.taskId ?? null,
        },
      );
      if (!transfer.ok) return fail('VALIDATION', transfer.error);
    }

    retestScheduleId = schedule.id;
    // 复测证据自动挂回原证据链（链根沿用父记录），避免形成孤立样本。
    parentEvidenceId = schedule.parentEvidenceId;
    chainRootId = schedule.parent.chainRootId ?? schedule.parent.id;
  }

  if (parentEvidenceId && !retestScheduleId) {
    const parent = await prisma.evidenceRecord.findUnique({
      where: { id: parentEvidenceId },
      select: { id: true, chainRootId: true, archivedAt: true },
    });
    if (!parent) return fail('NOT_FOUND', '父证据不存在或已被删除');
    if (parent.archivedAt) return fail('PRECONDITION', '父证据已归档，不能在其后新建版本');
    chainRootId = parent.chainRootId ?? parent.id;
  }

  if (input.taskId) {
    const task = await prisma.planTask.findUnique({ where: { id: input.taskId }, select: { id: true } });
    if (!task) return fail('NOT_FOUND', '关联任务不存在');
  }
  if (input.sessionId) {
    const session = await prisma.studySession.findUnique({
      where: { id: input.sessionId },
      select: { id: true },
    });
    if (!session) return fail('NOT_FOUND', '关联学习记录不存在');
  }
  if (input.mediatedId) {
    const mediated = await prisma.englishMediatedSession.findUnique({
      where: { id: input.mediatedId },
      select: { id: true },
    });
    if (!mediated) return fail('NOT_FOUND', '关联媒介学习记录不存在');
  }

  const createdAt = input.createdAtDate ? toUtcInstant(input.createdAtDate) : new Date();

  const evidenceId = await prisma.$transaction(async (tx) => {
    const created = await tx.evidenceRecord.create({
      data: {
        skill: input.skill,
        evidenceType: input.evidenceType,
        level: input.level ?? 'QUICK',
        parentEvidenceId,
        chainRootId,
        taskId: input.taskId ?? null,
        sessionId: input.sessionId ?? null,
        mediatedId: input.mediatedId ?? null,
        conditionJson: input.condition ? stringify(input.condition) : null,
        outputText: nullIfEmpty(input.outputText),
        score: input.score ?? null,
        scoreReason: nullIfEmpty(input.scoreReason),
        dimensionsJson: input.dimensions ? stringify(input.dimensions) : null,
        evidenceAnchor: nullIfEmpty(input.evidenceAnchor),
        assistanceLevel: input.assistanceLevel ?? 'A0',
        assessorType: input.assessorType ?? 'SELF',
        confidence: input.confidence ?? 'MEDIUM',
        privacyLevel: input.privacyLevel ?? 'PRIVATE',
        note: nullIfEmpty(input.note),
        createdAt,
        updatedAt: createdAt,
      },
      select: { id: true },
    });

    if (input.attachment) {
      const attachment = await tx.evidenceAttachment.create({
        data: {
          fileUri: input.attachment.fileUri.trim(),
          mimeType: nullIfEmpty(input.attachment.mimeType),
          evidenceType: input.attachment.evidenceType,
          linkedEntity: 'EVIDENCE_RECORD',
          linkedId: created.id,
          sizeBytes: input.attachment.sizeBytes ?? null,
          checksum: nullIfEmpty(input.attachment.checksum),
          privacyLevel: input.attachment.privacyLevel ?? 'PRIVATE',
          consentStatus: input.attachment.consentStatus ?? 'NOT_REQUIRED',
          note: nullIfEmpty(input.attachment.note),
        },
        select: { id: true },
      });
      await tx.evidenceRecord.update({
        where: { id: created.id },
        data: { artifactId: attachment.id },
      });
    }

    if (retestScheduleId) {
      await tx.retestSchedule.update({
        where: { id: retestScheduleId },
        data: { status: 'DONE', completedEvidenceId: created.id, completedAt: createdAt },
      });
    }

    // 基线或独立复测会补排后续阶梯；同一证据链已有排期则不重复生成。
    await ensureRetestChain(tx, {
      id: created.id,
      skill: input.skill,
      evidenceType: input.evidenceType,
      chainRootId,
      createdAt,
    });

    return created.id;
  });

  revalidateEvidencePages();
  return ok({ evidenceId });
}

/** 归档证据（软删除）。版本链与附件保留，列表默认不再展示。 */
export async function archiveEvidenceAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = archiveEvidenceSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.evidenceRecord.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, archivedAt: true },
  });
  if (!existing) return fail('NOT_FOUND', '证据不存在或已被删除');
  if (existing.archivedAt) return ok({ ok: true });

  await prisma.evidenceRecord.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
  });

  revalidateEvidencePages();
  return ok({ ok: true });
}
