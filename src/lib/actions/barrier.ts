'use server';

/**
 * 障碍诊断与定向修复 Server Actions。
 *
 * 约束落在这里（不只靠 UI）：
 * - 障碍类型必须匹配技能；原始样本必须同技能且未归档。
 * - 每轮只允许一个聚焦障碍（全局唯一）。
 * - 修复完成必须有后测样本；A4 不能当支架。
 * - 障碍归档 = 软删除，历史记录保留。
 */

import { revalidatePath } from 'next/cache';
import {
  BARRIER_REPAIR_PRESET_ZH,
  INTERVENTION_DEFAULT_SCAFFOLD,
} from '@/lib/constants';
import {
  canCompleteIntervention,
  canResolveBarrier,
  canTransitionIntervention,
  computeFocusChange,
} from '@/lib/domain/barrier';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import {
  barrierIdSchema,
  changeInterventionStatusSchema,
  createBarrierSchema,
  linkInterventionEvidenceSchema,
  upsertInterventionSchema,
} from '@/lib/schema/barrier';
import type { BarrierStatus, EvidenceSkill, InterventionStatus } from '@/lib/types';
import type { ActionResult } from '@/lib/types';

function revalidateDiagnosisPages() {
  revalidatePath('/diagnosis');
  revalidatePath('/evidence');
  revalidatePath('/');
}

export async function createBarrierAction(
  raw: unknown,
): Promise<ActionResult<{ barrierId: string }>> {
  const parsed = createBarrierSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  if (input.evidenceId) {
    const evidence = await prisma.evidenceRecord.findUnique({
      where: { id: input.evidenceId },
      select: { id: true, skill: true, archivedAt: true },
    });
    if (!evidence) return fail('NOT_FOUND', '原始样本不存在或已被删除');
    if (evidence.archivedAt) return fail('PRECONDITION', '原始样本已归档，不能作为诊断依据');
    if (evidence.skill !== input.skill) {
      return fail('PRECONDITION', '原始样本的技能与诊断技能不一致');
    }
  }

  const created = await prisma.barrierDiagnosis.create({
    data: {
      skill: input.skill,
      barrierType: input.barrierType,
      evidenceId: input.evidenceId ?? null,
      evidenceAnchor: nullIfEmpty(input.evidenceAnchor),
      impact: input.impact,
      confidence: input.confidence ?? 'MEDIUM',
      note: nullIfEmpty(input.note),
    },
    select: { id: true },
  });

  revalidateDiagnosisPages();
  return ok({ barrierId: created.id });
}

/** 设为当前聚焦障碍：清掉其他所有聚焦项（每轮只聚焦一个）。 */
export async function focusBarrierAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = barrierIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const rows = await prisma.barrierDiagnosis.findMany({
    select: { id: true, skill: true, status: true, selectedFocus: true, archivedAt: true },
  });
  const change = computeFocusChange(
    rows.map((row) => ({
      id: row.id,
      skill: row.skill as EvidenceSkill,
      status: row.status as BarrierStatus,
      selectedFocus: row.selectedFocus,
      archived: row.archivedAt !== null,
    })),
    parsed.data.id,
  );
  if (!change.ok) return fail('PRECONDITION', change.error);

  await prisma.$transaction(async (tx) => {
    if (change.clearIds.length > 0) {
      await tx.barrierDiagnosis.updateMany({
        where: { id: { in: change.clearIds } },
        data: { selectedFocus: false },
      });
    }
    await tx.barrierDiagnosis.update({
      where: { id: parsed.data.id },
      data: { selectedFocus: true },
    });
  });

  revalidateDiagnosisPages();
  return ok({ ok: true });
}

/** 新建或修改一条修复计划；已完成/已放弃的修复不能再改内容。 */
export async function upsertInterventionAction(
  raw: unknown,
): Promise<ActionResult<{ interventionId: string }>> {
  const parsed = upsertInterventionSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const barrier = await prisma.barrierDiagnosis.findUnique({
    where: { id: input.barrierId },
    select: { id: true, skill: true, status: true, archivedAt: true },
  });
  if (!barrier) return fail('NOT_FOUND', '障碍不存在或已被删除');
  if (barrier.archivedAt) return fail('PRECONDITION', '障碍已归档，不能新增修复计划');
  if (barrier.status !== 'ACTIVE') return fail('PRECONDITION', '只有诊断中的障碍才能规划修复');

  const preset = BARRIER_REPAIR_PRESET_ZH[barrier.skill as EvidenceSkill];

  if (input.id) {
    const existing = await prisma.interventionPlan.findUnique({
      where: { id: input.id },
      select: { id: true, barrierId: true, status: true },
    });
    if (!existing) return fail('NOT_FOUND', '修复计划不存在或已被删除');
    if (existing.barrierId !== input.barrierId) {
      return fail('PRECONDITION', '修复计划与障碍不匹配');
    }
    if (existing.status === 'DONE' || existing.status === 'ABANDONED') {
      return fail('PRECONDITION', '已完成或已放弃的修复不能修改；如需调整请新建一条。');
    }
    await prisma.interventionPlan.update({
      where: { id: existing.id },
      data: {
        action: input.action,
        successCriteria: input.successCriteria,
        scaffoldLevel: input.scaffoldLevel ?? INTERVENTION_DEFAULT_SCAFFOLD,
        estimatedMinutes: input.estimatedMinutes ?? preset.minutes,
      },
    });
    revalidateDiagnosisPages();
    return ok({ interventionId: existing.id });
  }

  const created = await prisma.interventionPlan.create({
    data: {
      barrierId: barrier.id,
      action: input.action,
      successCriteria: input.successCriteria,
      scaffoldLevel: input.scaffoldLevel ?? INTERVENTION_DEFAULT_SCAFFOLD,
      estimatedMinutes: input.estimatedMinutes ?? preset.minutes,
    },
    select: { id: true },
  });

  revalidateDiagnosisPages();
  return ok({ interventionId: created.id });
}

export async function changeInterventionStatusAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = changeInterventionStatusSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.interventionPlan.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, status: true, postEvidenceId: true },
  });
  if (!existing) return fail('NOT_FOUND', '修复计划不存在或已被删除');

  const from = existing.status as InterventionStatus;
  const to = parsed.data.status as InterventionStatus;
  if (!canTransitionIntervention(from, to)) {
    return fail('PRECONDITION', `不能从「${from}」直接变更为「${to}」；已完成/已放弃的修复不能再变。`);
  }
  if (to === 'DONE') {
    const check = canCompleteIntervention(existing.postEvidenceId);
    if (!check.ok) return fail('PRECONDITION', check.error);
  }

  await prisma.interventionPlan.update({
    where: { id: existing.id },
    data: { status: to },
  });

  revalidateDiagnosisPages();
  return ok({ ok: true });
}

/** 关联修复前/后样本；必须与障碍同技能、未归档。 */
export async function linkInterventionEvidenceAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = linkInterventionEvidenceSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const intervention = await prisma.interventionPlan.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      status: true,
      preEvidenceId: true,
      postEvidenceId: true,
      barrier: { select: { skill: true, archivedAt: true } },
    },
  });
  if (!intervention) return fail('NOT_FOUND', '修复计划不存在或已被删除');
  if (intervention.barrier.archivedAt) return fail('PRECONDITION', '障碍已归档，不能关联样本');

  const evidence = await prisma.evidenceRecord.findUnique({
    where: { id: parsed.data.evidenceId },
    select: { id: true, skill: true, archivedAt: true, createdAt: true },
  });
  if (!evidence) return fail('NOT_FOUND', '证据不存在或已被删除');
  if (evidence.archivedAt) return fail('PRECONDITION', '证据已归档，不能作为修复样本');
  if (evidence.skill !== intervention.barrier.skill) {
    return fail('PRECONDITION', '证据技能与障碍技能不一致');
  }

  if (parsed.data.role === 'POST') {
    if (intervention.status === 'DONE' || intervention.status === 'ABANDONED') {
      return fail('PRECONDITION', '已完成或已放弃的修复不能再更换后测样本');
    }
    if (intervention.preEvidenceId && intervention.preEvidenceId !== evidence.id) {
      const pre = await prisma.evidenceRecord.findUnique({
        where: { id: intervention.preEvidenceId },
        select: { createdAt: true },
      });
      if (pre && pre.createdAt.getTime() > evidence.createdAt.getTime()) {
        return fail('PRECONDITION', '后测样本不能早于修复前样本');
      }
    }
    await prisma.interventionPlan.update({
      where: { id: intervention.id },
      data: { postEvidenceId: evidence.id },
    });
  } else {
    if (intervention.postEvidenceId === evidence.id) {
      return fail('PRECONDITION', '修复前与后测不能是同一条证据');
    }
    await prisma.interventionPlan.update({
      where: { id: intervention.id },
      data: { preEvidenceId: evidence.id },
    });
  }

  revalidateDiagnosisPages();
  return ok({ ok: true });
}

export async function resolveBarrierAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = barrierIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const barrier = await prisma.barrierDiagnosis.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      status: true,
      archivedAt: true,
      interventions: { select: { status: true, postEvidenceId: true } },
    },
  });
  if (!barrier) return fail('NOT_FOUND', '障碍不存在或已被删除');
  if (barrier.archivedAt) return fail('PRECONDITION', '障碍已归档');
  if (barrier.status === 'RESOLVED') return ok({ ok: true });

  const check = canResolveBarrier(
    barrier.interventions.map((item) => ({
      status: item.status as InterventionStatus,
      postEvidenceId: item.postEvidenceId,
    })),
  );
  if (!check.ok) return fail('PRECONDITION', check.error);

  await prisma.barrierDiagnosis.update({
    where: { id: barrier.id },
    data: { status: 'RESOLVED', selectedFocus: false },
  });

  revalidateDiagnosisPages();
  return ok({ ok: true });
}

/** 归档障碍（软删除）。 */
export async function archiveBarrierAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = barrierIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.barrierDiagnosis.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, archivedAt: true },
  });
  if (!existing) return fail('NOT_FOUND', '障碍不存在或已被删除');
  if (existing.archivedAt) return ok({ ok: true });

  await prisma.barrierDiagnosis.update({
    where: { id: existing.id },
    data: { archivedAt: new Date(), selectedFocus: false },
  });

  revalidateDiagnosisPages();
  return ok({ ok: true });
}
