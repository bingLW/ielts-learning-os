'use server';

/**
 * 技能型复测排期操作。
 *
 * 约束落在这里（不只靠 UI）：
 * - 复测排期只从证据链派生；跳过/完成只能对 PENDING 排期操作。
 * - 「完成复测」复用证据录入（createEvidenceSchema.retestScheduleId），校验集中在证据 Action。
 * - 加入计划只处理已到期/逾期排期，且落到今天，避免提前占用未来日期的计划生成。
 */

import { revalidatePath } from 'next/cache';
import {
  MODULE_META,
  MODULE_TRACK,
  RETEST_PLAN_MODULE,
  RETEST_PLAN_PRIORITY,
} from '@/lib/constants';
import { today } from '@/lib/date';
import { previewOutput } from '@/lib/domain/evidence';
import { getActiveStage } from '@/lib/queries/stages';
import { prisma } from '@/lib/prisma';
import { ensureRetestChain } from '@/lib/retestSchedule';
import { fail, failValidation, ok } from '@/lib/result';
import {
  addRetestToPlanSchema,
  scheduleRetestSchema,
  skipRetestSchema,
} from '@/lib/schema/retest';
import { nullIfEmpty } from '@/lib/schema/common';
import type { ActionResult, ModuleId, PrimarySkill } from '@/lib/types';

function revalidateRetestPages() {
  revalidatePath('/retest');
  revalidatePath('/evidence');
  revalidatePath('/plan');
  revalidatePath('/');
}

const PLAN_PRIMARY_SKILL: Record<string, PrimarySkill> = {
  LISTENING: 'LISTENING',
  READING: 'READING',
  SPEAKING: 'SPEAKING',
  WRITING: 'WRITING',
};

/** 为一条活动证据补排复测阶梯（幂等：已有排期则不重复创建）。 */
export async function scheduleRetestAction(
  raw: unknown,
): Promise<ActionResult<{ created: number }>> {
  const parsed = scheduleRetestSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const evidence = await prisma.evidenceRecord.findUnique({
    where: { id: parsed.data.evidenceId },
    select: {
      id: true,
      skill: true,
      evidenceType: true,
      chainRootId: true,
      createdAt: true,
      archivedAt: true,
    },
  });
  if (!evidence) return fail('NOT_FOUND', '证据不存在或已被删除');
  if (evidence.archivedAt) return fail('PRECONDITION', '已归档证据不再排复测');

  const created = await prisma.$transaction((tx) => ensureRetestChain(tx, evidence));
  revalidateRetestPages();
  return ok({ created });
}

/** 跳过一条复测（可写原因；不删除排期，保留审计）。 */
export async function skipRetestAction(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  const parsed = skipRetestSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const schedule = await prisma.retestSchedule.findUnique({
    where: { id: parsed.data.scheduleId },
    select: { id: true, status: true },
  });
  if (!schedule) return fail('NOT_FOUND', '复测排期不存在');
  if (schedule.status !== 'PENDING') {
    return fail('PRECONDITION', '只有待完成的复测才能跳过');
  }

  await prisma.retestSchedule.update({
    where: { id: schedule.id },
    data: { status: 'SKIPPED', note: nullIfEmpty(parsed.data.note) },
  });
  revalidateRetestPages();
  return ok({ ok: true });
}

/**
 * 把一条已到期/逾期的复测加入今天的计划（模块 = 证据复测）。
 *
 * 只对已到期排期开放：未来排期若提前写入未来日期，会阻止当天的计划生成。
 */
export async function addRetestToPlanAction(
  raw: unknown,
): Promise<ActionResult<{ planTaskId: string }>> {
  const parsed = addRetestToPlanSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const schedule = await prisma.retestSchedule.findUnique({
    where: { id: parsed.data.scheduleId },
    include: {
      parent: {
        select: { skill: true, outputText: true, note: true },
      },
    },
  });
  if (!schedule) return fail('NOT_FOUND', '复测排期不存在');
  if (schedule.status !== 'PENDING') {
    return fail('PRECONDITION', '只有待完成的复测才能加入计划');
  }

  const todayStr = today();
  if (schedule.dueDate > todayStr) {
    return fail('PRECONDITION', '该复测尚未到期，到期后再加入当天计划');
  }

  if (schedule.planTaskId) {
    const exists = await prisma.planTask.findUnique({
      where: { id: schedule.planTaskId },
      select: { id: true },
    });
    if (exists) return ok({ planTaskId: exists.id });
  }

  const stage = await getActiveStage();
  if (!stage) return fail('PRECONDITION', '请先在「阶段与验收」页激活一个阶段');

  const preview = previewOutput(schedule.parent.outputText ?? schedule.parent.note, 40);
  const moduleMeta = MODULE_META[RETEST_PLAN_MODULE as ModuleId];

  const planTaskId = await prisma.$transaction(async (tx) => {
    const maxSort = await tx.planTask.aggregate({
      where: { planDate: todayStr },
      _max: { sortOrder: true },
    });
    const created = await tx.planTask.create({
      data: {
        stageId: stage.id,
        planDate: todayStr,
        module: RETEST_PLAN_MODULE,
        skill: moduleMeta?.skill ?? 'META',
        plannedMinutes: schedule.estMinutes,
        sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
        priority: `P${RETEST_PLAN_PRIORITY}`,
        sourceKind: 'REVIEW',
        track: MODULE_TRACK[RETEST_PLAN_MODULE as ModuleId] ?? 'GENERAL_ENGLISH',
        primarySkill: PLAN_PRIMARY_SKILL[schedule.parent.skill] ?? 'FOUNDATION',
        note: preview ? `证据复测：${preview}` : '证据复测',
      },
      select: { id: true },
    });
    await tx.retestSchedule.update({
      where: { id: schedule.id },
      data: { planTaskId: created.id },
    });
    return created.id;
  });

  revalidateRetestPages();
  return ok({ planTaskId });
}
