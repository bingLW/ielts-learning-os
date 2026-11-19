'use server';

/**
 * 计划生成与任务维护的 Server Actions。
 *
 * 统一返回 `ActionResult`，失败不 throw；写操作后 `revalidatePath`。
 */

import { revalidatePath } from 'next/cache';
import { MODULE_META, MODULE_TO_PRIMARY, MODULE_TRACK, tierCodeOf } from '@/lib/constants';
import { today } from '@/lib/date';
import { generateDailyPlan } from '@/lib/domain/plan';
import { generateAdaptivePlan } from '@/lib/domain/adaptivePlan';
import { prisma } from '@/lib/prisma';
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
  StageCode,
} from '@/lib/types';
import { getActiveStage } from '@/lib/queries/stages';
import { countTasksOfDate } from '@/lib/queries/plan';
import {
  activeAllocationFor,
  SKILL_TO_SUBJECT,
  loadPlanEngineContext,
  nextPlanVersion,
  primaryResourceMap,
} from '@/lib/queries/planning';

/** 生成当日计划（v2.0 兼容入口：240–300分钟固定引擎；v2.1 自适应引擎见下）。 */
export async function generatePlanAction(
  raw: unknown,
): Promise<ActionResult<{ taskCount: number; totalMinutes: number; warnings: string[] }>> {
  const parsed = generatePlanSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const stage = parsed.data.stageId
    ? await prisma.stage.findUnique({ where: { id: parsed.data.stageId } })
    : await getActiveStage();
  if (!stage) {
    return fail('PRECONDITION', '请先在「阶段与验收」页激活一个阶段，再生成计划');
  }

  const existing = await countTasksOfDate(parsed.data.planDate);
  if (existing > 0) {
    return fail('CONFLICT', `${parsed.data.planDate} 已有 ${existing} 条任务，未重复生成`);
  }

  const allocation = await activeAllocationFor(stage.profileCode);

  const plan = generateDailyPlan({
    dailyMinutes: parsed.data.dailyMinutes,
    stageCode: stage.code as StageCode,
    allocation,
  });
  if (!plan.ok) {
    if (plan.code === 'CAPACITY_EXCEEDED') {
      return fail('PRECONDITION', plan.error);
    }
    return fail('VALIDATION', '每日可用分钟必须在 240–300 之间');
  }

  const resourceMap = await primaryResourceMap();

  await prisma.$transaction(async (tx) => {
    await tx.planTask.createMany({
      data: plan.items.map((item) => {
        const subject = SKILL_TO_SUBJECT[item.skill];
        return {
          stageId: stage.id,
          planDate: parsed.data.planDate,
          module: item.module,
          skill: item.skill,
          plannedMinutes: item.minutes,
          sortOrder: item.sortOrder,
          resourceId: subject ? (resourceMap[subject] ?? null) : null,
          // v2.0：轨道与四技能粒度是任务的属性快照，聚合时不再依赖 module 反推
          track: item.track,
          primarySkill: item.primarySkill,
        };
      }),
    });
  });

  revalidatePath('/');
  revalidatePath('/plan');
  return ok({
    taskCount: plan.items.length,
    totalMinutes: plan.totalMinutes,
    warnings: plan.warnings,
  });
}

/** 新建单个任务。 */
export async function createPlanTaskAction(
  raw: unknown,
): Promise<ActionResult<{ taskId: string }>> {
  const parsed = createPlanTaskSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const maxSort = await prisma.planTask.aggregate({
    where: { planDate: parsed.data.planDate },
    _max: { sortOrder: true },
  });
  const sortOrder = parsed.data.sortOrder ?? (maxSort._max.sortOrder ?? -1) + 1;

  const created = await prisma.planTask.create({
    data: {
      stageId: parsed.data.stageId,
      planDate: parsed.data.planDate,
      module: parsed.data.module,
      skill: parsed.data.skill,
      plannedMinutes: parsed.data.plannedMinutes,
      sortOrder,
      resourceId: parsed.data.resourceId ?? null,
      note: parsed.data.note?.trim() ? parsed.data.note.trim() : null,
      // v2.0：未显式指定时按模块推导，保证每条任务落地时轨道/技能快照都非空
      track: (parsed.data.track ?? MODULE_TRACK[parsed.data.module]) as LearningTrack,
      primarySkill: (parsed.data.primarySkill ??
        MODULE_TO_PRIMARY[parsed.data.module]) as PrimarySkill,
    },
  });

  revalidatePath('/plan');
  return ok({ taskId: created.id });
}

/** 就地改时长 / 换资源 / 改备注。 */
export async function updatePlanTaskAction(
  raw: unknown,
): Promise<ActionResult<{ taskId: string }>> {
  const parsed = updatePlanTaskSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const task = await prisma.planTask.findUnique({ where: { id: parsed.data.taskId } });
  if (!task) return fail('NOT_FOUND', '任务不存在或已被删除');

  const data: Record<string, unknown> = {};
  if (parsed.data.plannedMinutes !== undefined) data.plannedMinutes = parsed.data.plannedMinutes;
  if (parsed.data.resourceId !== undefined) {
    data.resourceId = parsed.data.resourceId === '' ? null : parsed.data.resourceId;
  }
  if (parsed.data.note !== undefined) {
    data.note = parsed.data.note.trim() ? parsed.data.note.trim() : null;
  }
  if (Object.keys(data).length === 0) return ok({ taskId: task.id });

  await prisma.planTask.update({ where: { id: task.id }, data });
  revalidatePath('/plan');
  revalidatePath('/');
  return ok({ taskId: task.id });
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
  return ok({ today: today() });
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

/**
 * v2.1 自适应计划生成（支持 15–600 分钟任意预算）。
 *
 * 与 v2.0 `generatePlanAction` 的区别：
 * - v2.0 用固定引擎，240–300 分钟，9 模块；
 * - v2.1 用自适应引擎，1–600 分钟，动态模块数，带优先级/可拆分/弱项/到期复习。
 */
export async function generateAdaptivePlanAction(
  raw: unknown,
): Promise<
  ActionResult<{ taskCount: number; totalMinutes: number; warnings: string[]; version: number }>
> {
  const parsed = generateAdaptivePlanSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const { planDate, dailyMinutes, stageId } = parsed.data;

  const [stage, existing] = await Promise.all([
    stageId ? prisma.stage.findUnique({ where: { id: stageId } }) : getActiveStage(),
    countTasksOfDate(planDate),
  ]);

  if (!stage) {
    return fail('PRECONDITION', '请先在「阶段与验收」页激活一个阶段');
  }
  if (existing > 0) {
    return fail('CONFLICT', `${planDate} 已有 ${existing} 条任务，未重复生成`);
  }

  // 零预算 = 休息日：不生成任务，也不写空版本（重复点会堆版本号）。
  // 只看本次确认的分钟数 —— 之前存过休息日不该压过用户现在明确给出的时长。
  if (dailyMinutes === 0) {
    return ok({
      taskCount: 0,
      totalMinutes: 0,
      warnings: ['休息日 / 零预算：不生成学习任务，本次不计为学习失败。'],
      version: 0,
    });
  }

  const context = await loadPlanEngineContext(planDate, stage);
  const version = await nextPlanVersion(planDate);
  // 档次只由本次确认的分钟数决定：75 分钟就是「自定义」，不借用已保存预算的档次模板
  const tierCode = tierCodeOf(dailyMinutes);

  const result = generateAdaptivePlan({
    ...context,
    budgetMinutes: dailyMinutes,
    isRestDay: false,
    tierCode,
  });

  if (!result.ok) {
    return fail('VALIDATION', result.code === 'INVALID_BUDGET' ? '预算不合法' : '生成失败');
  }

  const resourceMap = await primaryResourceMap();

  await prisma.$transaction(async (tx) => {
    // 预算与计划同一事务落库：计划是按这个分钟数生成的，两者不能各说各话
    const budgetData = {
      plannedAvailableMinutes: dailyMinutes,
      budgetType: tierCode === 'CUSTOM' ? 'CUSTOM' : 'PRESET',
      tierCode,
      isRestDay: false,
      isInitialSuggestion: false,
      source: 'USER',
    };
    await tx.dailyBudget.upsert({
      where: { date: planDate },
      update: budgetData,
      create: { date: planDate, ...budgetData },
    });

    await tx.planTask.createMany({
      data: result.items.map((item) => {
        const subject = SKILL_TO_SUBJECT[item.skill];
        return {
          stageId: stage.id,
          planDate,
          module: item.module,
          skill: item.skill,
          plannedMinutes: item.minutes,
          sortOrder: item.sortOrder,
          track: item.track,
          primarySkill: item.primarySkill,
          priority: item.priority,
          sourceKind: item.sourceKind,
          splittable: item.splittable,
          minChunkMinutes: item.minChunkMinutes,
          planVersion: version,
          originalScheduledDate: planDate,
          resourceId: subject ? (resourceMap[subject] ?? null) : null,
          note: item.rationale,
        };
      }),
    });

    await tx.planVersion.create({
      data: {
        planDate,
        version,
        changeSource: 'GENERATE',
        budgetMinutes: dailyMinutes,
        actualMinutesAtChange: 0,
        afterSnapshot: JSON.stringify({
          taskCount: result.items.length,
          totalMinutes: result.totalPlannedMinutes,
          backlog: result.backlog,
        }),
      },
    });
  });

  revalidatePath('/');
  revalidatePath('/plan');
  return ok({
    taskCount: result.items.length,
    totalMinutes: result.totalPlannedMinutes,
    warnings: result.warnings,
    version,
  });
}
