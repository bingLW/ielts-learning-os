'use server';

/**
 * 90 天周期与每周复盘 Server Actions。
 *
 * 约束不只靠 UI：
 * - 同一时间只允许一个进行中的周期；
 * - 阶段推进 / 完成周期都有证据门槛（domain/cycle 纯函数判定）；
 * - 每周只留一个主问题；「已复盘」必须补齐输入/输出/反馈/下周决定；
 * - 中断恢复只记录客观原因 + 24 小时内的最小下一步，不补积压任务。
 */

import { revalidatePath } from 'next/cache';
import {
  CYCLE_TOTAL_DAYS,
  CYCLE_WEEKS,
} from '@/lib/constants';
import { countCycleEvidence } from '@/lib/cycleCounts';
import { addDays, today } from '@/lib/date';
import {
  canReviewWeeklyFocus,
  checkCycleCompletion,
  checkPhaseAdvance,
  computeCycleProgress,
  cycleDayNumber,
  cyclePhaseForDay,
  cycleWeekStart,
  nextCyclePhase,
} from '@/lib/domain/cycle';
import { stringifyArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import {
  createCycleSchema,
  cycleIdSchema,
  saveRecoverySchema,
  upsertWeeklyFocusSchema,
} from '@/lib/schema/cycle';
import type { ActionResult, CyclePhaseCode, CycleStatus, EvidenceSkill } from '@/lib/types';

function revalidateCyclePages() {
  revalidatePath('/cycle');
  revalidatePath('/');
}

async function loadCycle(cycleId: string) {
  return prisma.learningCycle.findUnique({ where: { id: cycleId } });
}

/** 新建周期：自动抓取各技能最新一条基线证据作为 baselineRefs。 */
export async function createCycleAction(
  raw: unknown,
): Promise<ActionResult<{ cycleId: string }>> {
  const parsed = createCycleSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const active = await prisma.learningCycle.findFirst({
    where: { archivedAt: null, status: { not: 'COMPLETED' } },
    select: { id: true, title: true },
  });
  if (active) {
    return fail('CONFLICT', `已有进行中的周期「${active.title}」，请先完成该周期再开启新的 90 天`);
  }

  const baselines = await prisma.evidenceRecord.findMany({
    where: { archivedAt: null, evidenceType: 'BASELINE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, skill: true },
  });
  const seenSkills = new Set<EvidenceSkill>();
  const baselineRefs: string[] = [];
  for (const row of baselines) {
    const skill = row.skill as EvidenceSkill;
    if (seenSkills.has(skill)) continue;
    seenSkills.add(skill);
    baselineRefs.push(row.id);
  }

  const endDate = addDays(input.startDate, CYCLE_TOTAL_DAYS - 1);
  const dayNumber = cycleDayNumber(input.startDate, today());
  const status: CycleStatus =
    dayNumber > CYCLE_TOTAL_DAYS
      ? 'COMPLETED'
      : (cyclePhaseForDay(dayNumber) ?? 'CALIBRATION');

  const created = await prisma.learningCycle.create({
    data: {
      title: input.title,
      goal: input.goal,
      deliverable: nullIfEmpty(input.deliverable),
      startDate: input.startDate,
      endDate,
      status,
      baselineRefs: stringifyArray(baselineRefs),
    },
    select: { id: true },
  });

  revalidateCyclePages();
  return ok({ cycleId: created.id });
}

/** 推进到下一阶段（校准→积累→交付），门槛不满足直接拒绝。 */
export async function advanceCyclePhaseAction(
  raw: unknown,
): Promise<ActionResult<{ status: CyclePhaseCode }>> {
  const parsed = cycleIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const row = await loadCycle(parsed.data.cycleId);
  if (!row || row.archivedAt) return fail('NOT_FOUND', '周期不存在或已归档');
  if (row.status === 'COMPLETED') return fail('CONFLICT', '周期已完成，不能继续推进');
  if (row.status === 'PAUSED') return fail('PRECONDITION', '周期已暂停，请先恢复再推进阶段');

  const counts = await countCycleEvidence(row.startDate, row.endDate);
  const gate = checkPhaseAdvance(row.status as CyclePhaseCode, counts);
  if (!gate.ok) return fail('VALIDATION', gate.error);

  const next = nextCyclePhase(row.status as CyclePhaseCode);
  if (!next) return fail('CONFLICT', '没有下一阶段');

  await prisma.learningCycle.update({ where: { id: row.id }, data: { status: next } });
  revalidateCyclePages();
  return ok({ status: next });
}

/** 暂停周期：保留日期与进度，恢复时按当天日期重新落到阶段。 */
export async function pauseCycleAction(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  const parsed = cycleIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const row = await loadCycle(parsed.data.cycleId);
  if (!row || row.archivedAt) return fail('NOT_FOUND', '周期不存在或已归档');
  if (row.status === 'COMPLETED') return fail('CONFLICT', '周期已完成，不能暂停');
  if (row.status === 'PAUSED') return ok({ ok: true });

  await prisma.learningCycle.update({ where: { id: row.id }, data: { status: 'PAUSED' } });
  revalidateCyclePages();
  return ok({ ok: true });
}

/** 恢复周期：按当天日期落到校准/积累/交付；已超 90 天则回到交付阶段等待完成。 */
export async function resumeCycleAction(
  raw: unknown,
): Promise<ActionResult<{ status: CyclePhaseCode }>> {
  const parsed = cycleIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const row = await loadCycle(parsed.data.cycleId);
  if (!row || row.archivedAt) return fail('NOT_FOUND', '周期不存在或已归档');
  if (row.status !== 'PAUSED') return fail('PRECONDITION', '只有已暂停的周期才能恢复');

  const progress = computeCycleProgress(row.startDate, today());
  const next: CyclePhaseCode = progress.phase ?? 'DELIVER';

  await prisma.learningCycle.update({ where: { id: row.id }, data: { status: next } });
  revalidateCyclePages();
  return ok({ status: next });
}

/** 完成周期：需已过积累期且至少 1 条实际应用/迁移证据。 */
export async function completeCycleAction(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  const parsed = cycleIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const row = await loadCycle(parsed.data.cycleId);
  if (!row || row.archivedAt) return fail('NOT_FOUND', '周期不存在或已归档');
  if (row.status === 'COMPLETED') return ok({ ok: true });
  if (row.status === 'PAUSED') return fail('PRECONDITION', '周期已暂停，请先恢复再完成');

  const counts = await countCycleEvidence(row.startDate, row.endDate);
  const progress = computeCycleProgress(row.startDate, today());
  const gate = checkCycleCompletion(progress.dayNumber, counts);
  if (!gate.ok) return fail('VALIDATION', gate.error);

  await prisma.learningCycle.update({ where: { id: row.id }, data: { status: 'COMPLETED' } });
  revalidateCyclePages();
  return ok({ ok: true });
}

/** 保存中断恢复说明（客观原因 + 24 小时内最小下一步）。 */
export async function saveRecoveryNoteAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = saveRecoverySchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const row = await loadCycle(parsed.data.cycleId);
  if (!row || row.archivedAt) return fail('NOT_FOUND', '周期不存在或已归档');
  if (row.status === 'COMPLETED') return fail('CONFLICT', '周期已完成，不能再写恢复说明');

  await prisma.learningCycle.update({
    where: { id: row.id },
    data: { recoveryNote: parsed.data.recoveryNote.trim() },
  });
  revalidateCyclePages();
  return ok({ ok: true });
}

/** 新建或更新某一周的复盘；一个周期内每周一行（upsert）。 */
export async function upsertWeeklyFocusAction(
  raw: unknown,
): Promise<ActionResult<{ focusId: string; status: 'OPEN' | 'REVIEWED' }>> {
  const parsed = upsertWeeklyFocusSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const cycle = await loadCycle(input.cycleId);
  if (!cycle || cycle.archivedAt) return fail('NOT_FOUND', '周期不存在或已归档');
  if (cycle.status === 'COMPLETED') {
    return fail('CONFLICT', '周期已完成，周复盘不可再修改');
  }

  const weekIndex = Math.min(Math.max(input.weekIndex, 1), CYCLE_WEEKS);
  const weekStart = cycleWeekStart(cycle.startDate, weekIndex);

  if (input.transferEvidenceId) {
    const evidence = await prisma.evidenceRecord.findUnique({
      where: { id: input.transferEvidenceId },
      select: { id: true, archivedAt: true },
    });
    if (!evidence) return fail('NOT_FOUND', '迁移证据不存在或已被删除');
    if (evidence.archivedAt) return fail('PRECONDITION', '迁移证据已归档，不能挂到周复盘');
  }

  const reviewed = input.reviewed ?? false;
  if (reviewed) {
    const gate = canReviewWeeklyFocus({
      focusQuestion: input.focusQuestion,
      inputText: input.inputText ?? null,
      outputText: input.outputText ?? null,
      feedbackText: input.feedbackText ?? null,
      nextDecision: input.nextDecision ?? null,
    });
    if (!gate.ok) return fail('VALIDATION', gate.error);
  }

  const saveSucceeded = await prisma.$transaction(async (tx) => {
    const saved = await tx.weeklyFocus.upsert({
      where: { cycleId_weekIndex: { cycleId: cycle.id, weekIndex } },
      create: {
        cycleId: cycle.id,
        weekIndex,
        weekStart,
        focusQuestion: input.focusQuestion,
        inputText: nullIfEmpty(input.inputText),
        outputText: nullIfEmpty(input.outputText),
        feedbackText: nullIfEmpty(input.feedbackText),
        transferEvidenceId: input.transferEvidenceId ?? null,
        nextDecision: nullIfEmpty(input.nextDecision),
        status: reviewed ? 'REVIEWED' : 'OPEN',
      },
      update: {
        weekStart,
        focusQuestion: input.focusQuestion,
        inputText: nullIfEmpty(input.inputText),
        outputText: nullIfEmpty(input.outputText),
        feedbackText: nullIfEmpty(input.feedbackText),
        transferEvidenceId: input.transferEvidenceId ?? null,
        nextDecision: nullIfEmpty(input.nextDecision),
        status: reviewed ? 'REVIEWED' : 'OPEN',
      },
      select: { id: true },
    });
    return saved.id;
  });

  revalidateCyclePages();
  return ok({ focusId: saveSucceeded, status: reviewed ? 'REVIEWED' : 'OPEN' });
}
