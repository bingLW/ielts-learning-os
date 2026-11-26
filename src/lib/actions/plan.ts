'use server';

/**
 * 计划生成与任务维护的 Server Actions。
 *
 * 统一返回 `ActionResult`，失败不 throw；写操作后 `revalidatePath`。
 */

import { revalidatePath } from 'next/cache';
import { MODULE_META, MODULE_TO_PRIMARY, MODULE_TRACK } from '@/lib/constants';
import { businessToday } from '@/lib/businessTime';
import { prisma } from '@/lib/prisma';
import { appendTaskFromCandidate, updatePlanTask } from '@/lib/services/planWrite';
import { fail, failValidation, ok } from '@/lib/result';
import {
  createPlanTaskSchema,
  generateAdaptivePlanSchema,
  generatePlanSchema,
  reorderPlanTasksSchema,
  updatePlanTaskSchema,
} from '@/lib/schema/plan';
import type {
  ActionResult,
  LearningTrack,
  ModuleId,
  PrimarySkill,
  SkillId,
} from '@/lib/types';

const LEGACY_GENERATE_MESSAGE = '旧计划生成入口已停用，请使用 /planner/build 预览并确认正式计划';
/** Legacy v2.0 生成入口：保留签名，但禁止绕过统一 Planner 写入。 */
export async function generatePlanAction(
  raw: unknown,
): Promise<ActionResult<{ taskCount: number; totalMinutes: number; warnings: string[] }>> {
  const parsed = generatePlanSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  return fail('PRECONDITION', LEGACY_GENERATE_MESSAGE);
}

/**
 * 新建单个任务（v2.7 Q6：内部走唯一写入者；签名与返回不变）。
 *
 * 手工任务没有候选来源，`sourceKind` 直接取 `MANUAL`（已是 `TaskSourceKind`，
 * 不经候选域映射）；`priority` 取 P1，与 v2.6 的默认值一致。
 * 预算闸门、版本审计、`splittable` 派生都下沉到 `appendTaskFromCandidate`，
 * 本入口不再自己算 `sortOrder`（写入者内部按当日最大值 +1）。
 */
export async function createPlanTaskAction(
  raw: unknown,
): Promise<ActionResult<{ taskId: string }>> {
  const parsed = createPlanTaskSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const created = await appendTaskFromCandidate({
    stageId: parsed.data.stageId,
    planDate: parsed.data.planDate,
    module: parsed.data.module,
    skill: parsed.data.skill,
    plannedMinutes: parsed.data.plannedMinutes,
    priority: 'P1',
    sourceKind: 'MANUAL',
    track: (parsed.data.track ?? MODULE_TRACK[parsed.data.module]) as LearningTrack,
    primarySkill: (parsed.data.primarySkill ??
      MODULE_TO_PRIMARY[parsed.data.module]) as PrimarySkill,
    resourceId: parsed.data.resourceId ?? null,
    note: parsed.data.note?.trim() ? parsed.data.note.trim() : null,
    origin: 'MANUAL_ADD',
  });
  if (!created.ok) return fail(created.code, created.error, created.fieldErrors);

  revalidatePath('/plan');
  return ok({ taskId: created.data.taskId });
}

/** 就地改时长 / 换资源 / 改备注。 */
export async function updatePlanTaskAction(
  raw: unknown,
): Promise<ActionResult<{ taskId: string }>> {
  const parsed = updatePlanTaskSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const updated = await updatePlanTask({
    taskId: parsed.data.taskId,
    plannedMinutes: parsed.data.plannedMinutes,
    resourceId: parsed.data.resourceId === '' ? null : parsed.data.resourceId,
    note:
      parsed.data.note === undefined
        ? undefined
        : parsed.data.note.trim()
          ? parsed.data.note.trim()
          : null,
  });
  if (!updated.ok) return fail(updated.code, updated.error, updated.fieldErrors);

  revalidatePath('/plan');
  revalidatePath('/');
  return ok({ taskId: updated.data.taskId });
}

/** 拖拽/上下移动后的顺序持久化（事务内按数组序重写 `sortOrder`）。 */
export async function reorderPlanTasksAction(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  const parsed = reorderPlanTasksSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { planDate, orderedIds } = parsed.data;
  const tasks = await prisma.planTask.findMany({
    where: { planDate, id: { in: orderedIds } },
    select: { id: true },
  });
  if (tasks.length !== orderedIds.length) {
    return fail('PRECONDITION', '顺序列表与当日任务不匹配，请刷新后重试');
  }

  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.planTask.update({ where: { id }, data: { sortOrder: index } }),
    ),
  );

  revalidatePath('/plan');
  return ok({ ok: true });
}

/** 删除任务（仅允许删除尚未开始的任务，避免抹掉已产生的计时历史）。 */
export async function deletePlanTaskAction(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  const taskId = typeof raw === 'object' && raw !== null ? (raw as { taskId?: unknown }).taskId : null;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return fail('VALIDATION', '缺少任务 ID');
  }
  const task = await prisma.planTask.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, timerStatus: true, _count: { select: { sessions: true } } },
  });
  if (!task) return fail('NOT_FOUND', '任务不存在或已被删除');
  if (task._count.sessions > 0 || task.timerStatus !== 'IDLE') {
    return fail('PRECONDITION', '该任务已有计时记录，不能删除；请改为标记未完成');
  }

  await prisma.planTask.delete({ where: { id: taskId } });
  revalidatePath('/plan');
  return ok({ ok: true });
}

/** 今日日期（供客户端组件取业务日期，避免组件内 `new Date()`）。 */
export async function todayAction(): Promise<ActionResult<{ today: string }>> {
  return ok({ today: await businessToday() });
}

/** 模块元数据（客户端渲染下拉时用，避免在组件里复制常量表）。 */
export async function modulesAction(): Promise<
  ActionResult<{ module: ModuleId; labelZh: string; defaultMinutes: number; skill: SkillId }[]>
> {
  const list = (Object.keys(MODULE_META) as ModuleId[]).map((module) => ({
    module,
    labelZh: MODULE_META[module].labelZh,
    defaultMinutes: MODULE_META[module].defaultMinutes,
    skill: MODULE_META[module].skill,
  }));
  return ok(list);
}

/** Legacy v2.1 生成入口：保留签名，但禁止绕过统一 Planner 预览与确认。 */
export async function generateAdaptivePlanAction(
  raw: unknown,
): Promise<
  ActionResult<{ taskCount: number; totalMinutes: number; warnings: string[]; version: number }>
> {
  const parsed = generateAdaptivePlanSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  return fail('PRECONDITION', LEGACY_GENERATE_MESSAGE);
}
