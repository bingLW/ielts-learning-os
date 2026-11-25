/**
 * v2.7 T08 `previewReplan()` + `confirmReplan()` —— dry-run 与确认。
 *
 * 铁律（`41 §2.7` / PRD §5.1）：
 * 1. **预览零写库**：不建 `PlanTask` / `PlanVersion` / `PlanningSnapshot`，也不写。
 * 2. **直接复用 `replanDailyTasks()`**（`domain/replan.ts` 纯函数），禁止写第二套简化重排。
 * 3. **无状态 `previewToken`** 保证「预览 == 实际」：确认时重新计算，不等 → `CONFLICT`。
 *    令牌里必须带上 `status` 与 `actualMinutes`（风险①：漏了会让计时中途确认把
 *    已发生时长算错）。
 * 4. **`diffPlan()` 只做对比**，不做任何决策。
 *
 * 与 `carryover` 的顺序（T08 风险③）：**先 carryover 决策，再 replan**。
 * 本文件只做 replan；carryover 的产物由调用方作为「当日已有任务」传入。
 */

import { createHash } from 'node:crypto';
import type { PlanTask } from '@prisma/client';
import { MODULE_META } from '@/lib/constants';
import { RULE_VERSION } from '@/lib/domain/planningSnapshot';
import { diffPlan, type DiffRow, type ReplanDiff } from '@/lib/domain/planDiff';
import {
  replanDailyTasks,
  type BacklogItem,
  type ExistingTask,
  type NewTaskSpec,
  type ReplanAction,
} from '@/lib/domain/replan';
import { getEffectiveBudget, getPlannerSettings } from '@/lib/queries/budget';
import { getNetMinutesOfDate } from '@/lib/queries/plan';
import {
  loadPlanEngineContext,
  nextPlanVersion,
  primaryResourceMap,
  SKILL_TO_SUBJECT,
} from '@/lib/queries/planning';
import { getActiveStage } from '@/lib/queries/stages';
import { prisma } from '@/lib/prisma';
import { fail, ok } from '@/lib/result';
import type {
  ActionResult,
  LearningTrack,
  ModuleId,
  TaskPriority,
  TaskSourceKind,
  TaskStatus,
} from '@/lib/types';

/** 重排预览输入（`41 §2.7`）。 */
export interface ReplanPreviewInput {
  planDate: string;
  newBudgetMinutes: number;
  isRestDay?: boolean;
  reason?: string;
  /** 用户锁定的任务（不参与重排）。 */
  lockedTaskIds?: string[];
}

/** 重排预览结果（`41 §2.7`）。 */
export interface ReplanPreviewResult {
  diff: ReplanDiff;
  /** 无状态预览令牌：确认时校验，保证「预览 == 实际」。 */
  previewToken: string;
  snapshotId: string;
}

export interface ConfirmReplanInput extends ReplanPreviewInput {
  previewToken: string;
  idempotencyKey: string;
}

/** 一次 dry-run 的完整中间产物（preview 与 confirm 共用同一份计算）。 */
interface ReplanDryRun {
  stageId: string;
  existingTasks: ExistingTask[];
  nextVersion: number;
  actualMinutesToday: number;
  diff: ReplanDiff;
  previewToken: string;
  snapshotId: string;
  actions: ReplanAction[];
  newTasks: NewTaskSpec[];
  scheduledRetestIds: string[];
}

function mapToExistingTask(row: PlanTask): ExistingTask {
  return {
    id: row.id,
    module: row.module,
    skill: row.skill,
    plannedMinutes: row.plannedMinutes,
    actualMinutes: row.actualMinutes,
    status: row.status as TaskStatus,
    priority: (row.priority ?? 'P1') as TaskPriority,
    sourceKind: row.sourceKind as TaskSourceKind,
    splittable: row.splittable,
    minChunkMinutes: row.minChunkMinutes,
    sortOrder: row.sortOrder,
    planVersion: row.planVersion,
    timerRunning: row.timerStatus === 'RUNNING',
    track: row.track as LearningTrack,
    primarySkill: row.primarySkill,
    resourceId: row.resourceId,
    note: row.note,
  };
}

function moduleLabel(module: string): string {
  return MODULE_META[module as ModuleId]?.labelZh ?? module;
}

function isProtected(task: ExistingTask): boolean {
  return task.status === 'DONE' || task.status === 'PARTIAL' || task.timerRunning === true;
}

/** 与 `buildPlanningSnapshot.weightsVersionOf` 同口径（默认 'v1'）。 */
function weightsVersionOf(raw: string | null | undefined): string {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    return typeof parsed.weightsVersion === 'string' && parsed.weightsVersion.length > 0
      ? parsed.weightsVersion
      : 'v1';
  } catch {
    return 'v1';
  }
}

/** `before` 行。 */
function beforeRow(task: ExistingTask, planDate: string, reason: string, protectedFlag: boolean): DiffRow {
  return {
    key: task.id,
    title: moduleLabel(task.module),
    date: planDate,
    minutes: task.plannedMinutes,
    priority: task.priority,
    module: task.module as ModuleId,
    reason,
    protected: protectedFlag,
  };
}

/** `after` 行（复用 before 的键，但分钟/优先级可能已变）。 */
function afterRow(
  task: ExistingTask,
  planDate: string,
  reason: string,
  minutes: number,
): DiffRow {
  return {
    key: task.id,
    title: moduleLabel(task.module),
    date: planDate,
    minutes,
    priority: task.priority,
    module: task.module as ModuleId,
    reason,
  };
}

/** 新任务 → `after` 行（`NewTaskSpec` 无 candidateKey，用 sortOrder 作稳定键）。 */
function newTaskRow(spec: NewTaskSpec, planDate: string): DiffRow {
  return {
    key: `new:${spec.sortOrder}`,
    title: moduleLabel(spec.module),
    date: planDate,
    minutes: spec.plannedMinutes,
    priority: spec.priority,
    module: spec.module as ModuleId,
    reason: spec.rationale,
  };
}

interface BuildDiffArgs {
  planDate: string;
  newBudgetMinutes: number;
  budgetBeforeMinutes: number;
  locked: ExistingTask[];
  unlocked: ExistingTask[];
  actions: ReplanAction[];
  newTasks: NewTaskSpec[];
  backlog: BacklogItem[];
  warnings: string[];
}

function buildDiff(args: BuildDiffArgs): ReplanDiff {
  const { planDate } = args;
  const actionByTaskId = new Map(args.actions.map((action) => [action.taskId, action]));

  const before: DiffRow[] = [];
  const after: DiffRow[] = [];

  // 锁定任务：受保护，不参与重排，原样保留（before == after）。
  for (const task of args.locked) {
    const row = beforeRow(task, planDate, '用户锁定，不参与重排', true);
    before.push(row);
    after.push({ ...row });
  }

  // 未锁定任务：按 replan 指令翻译成 before/after。
  for (const task of args.unlocked) {
    const action = actionByTaskId.get(task.id);
    // CANCELLED / DEFERRED / MISSED 是已做出的决定：不在当日计划内，也不产生 diff。
    if (!action) continue;

    const protectedFlag = isProtected(task);
    if (action.type === 'KEEP') {
      before.push(beforeRow(task, planDate, action.reason, protectedFlag));
      after.push(afterRow(task, planDate, action.reason, task.plannedMinutes));
    } else if (action.type === 'SHRINK') {
      before.push(beforeRow(task, planDate, action.reason, protectedFlag));
      after.push(afterRow(task, planDate, action.reason, action.newPlannedMinutes));
    } else {
      // DEFER：从当日移除（REMOVE），不产生 after 行。
      before.push(beforeRow(task, planDate, action.reason, protectedFlag));
    }
  }

  // 新增任务 → ADD。
  for (const spec of args.newTasks) {
    after.push(newTaskRow(spec, planDate));
  }

  const backlogMinutes = args.backlog.reduce((sum, item) => sum + Math.max(0, item.minutes), 0);

  return diffPlan({
    planDate,
    budgetMinutes: args.newBudgetMinutes,
    budgetBeforeMinutes: args.budgetBeforeMinutes,
    before,
    after,
    backlogMinutes,
    warnings: args.warnings,
  });
}

/** 计算无状态预览令牌与快照 id（`41 §2.7` 1512–1519）。 */
function fingerprintTokens(args: {
  planDate: string;
  newBudgetMinutes: number;
  isRestDay: boolean;
  weightsVersion: string;
  existingTasks: ExistingTask[];
  actualMinutesToday: number;
  lockedTaskIds: string[];
}): { previewToken: string; snapshotId: string } {
  const sortedTaskFingerprint = [...args.existingTasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => `${t.id}:${t.status}:${t.plannedMinutes}:${t.actualMinutes}:${t.planVersion}`)
    .join(',');

  const sortedLockedIds = [...args.lockedTaskIds].sort().join(',');

  const payload = [
    'replan',
    RULE_VERSION,
    args.weightsVersion,
    args.planDate,
    String(args.newBudgetMinutes),
    args.isRestDay ? 1 : 0,
    sortedTaskFingerprint,
    String(args.actualMinutesToday),
    sortedLockedIds,
  ].join('|');

  return {
    previewToken: createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 24),
    snapshotId: createHash('sha256')
      .update(`replan-snapshot|${payload}`, 'utf8')
      .digest('hex')
      .slice(0, 24),
  };
}

/** 读库 + 调用 `replanDailyTasks()` + 组 diff + 算 token。preview 与 confirm 共用。 */
async function runReplan(input: ReplanPreviewInput): Promise<ActionResult<ReplanDryRun>> {
  const stage = await getActiveStage();
  if (!stage) return fail('PRECONDITION', '请先在「阶段与验收」页激活一个阶段');

  const rows = await prisma.planTask.findMany({
    where: { planDate: input.planDate },
    orderBy: { sortOrder: 'asc' },
  });
  if (rows.length === 0) {
    return fail('PRECONDITION', '当日尚无任务，请直接生成计划，无需重排');
  }

  const existingTasks = rows.map(mapToExistingTask);
  const lockedIds = new Set(input.lockedTaskIds ?? []);
  const locked = existingTasks.filter((task) => lockedIds.has(task.id));
  const unlocked = existingTasks.filter((task) => !lockedIds.has(task.id));

  // 锁定任务仍占用预算：把它们「未完成尾巴」从新预算里预扣，交给引擎的剩余预算
  // 就不会把这些时间重复排给新任务（否则锁定 + 新任务会超预算）。
  const reservedByLocked = locked
    .filter((task) => task.status === 'TODO' || task.status === 'IN_PROGRESS')
    .reduce(
      (sum, task) => sum + Math.max(0, task.plannedMinutes - Math.max(0, task.actualMinutes)),
      0,
    );
  const effectiveBudget = Math.max(0, Math.round(input.newBudgetMinutes) - reservedByLocked);

  const actualMinutesToday = await getNetMinutesOfDate(input.planDate);
  const nextVersion = await nextPlanVersion(input.planDate);
  const isRestDay = input.isRestDay ?? input.newBudgetMinutes === 0;

  // 未开始任务即将被 DEFER，挂在其上的复测要重新计入预算（与 v2.1 replan action 同口径）。
  const deferrableIds = unlocked
    .filter((task) => task.status === 'TODO' && task.actualMinutes <= 0)
    .map((task) => task.id);
  const planInput = await loadPlanEngineContext(input.planDate, stage, deferrableIds);

  const replan = replanDailyTasks({
    existingTasks: unlocked,
    newBudgetMinutes: effectiveBudget,
    isRestDay,
    planInput,
    nextVersion,
    actualMinutesToday,
  });
  if (!replan.ok) return fail('VALIDATION', replan.error);

  const [budgetBefore, settings] = await Promise.all([
    getEffectiveBudget(input.planDate),
    getPlannerSettings(),
  ]);
  const weightsVersion = weightsVersionOf(settings?.priorityPolicy);

  const diff = buildDiff({
    planDate: input.planDate,
    newBudgetMinutes: input.newBudgetMinutes,
    budgetBeforeMinutes: budgetBefore.minutes,
    locked,
    unlocked,
    actions: replan.actions,
    newTasks: replan.newTasks,
    backlog: replan.backlog,
    warnings: replan.warnings,
  });

  const tokens = fingerprintTokens({
    planDate: input.planDate,
    newBudgetMinutes: input.newBudgetMinutes,
    isRestDay,
    weightsVersion,
    existingTasks,
    actualMinutesToday,
    lockedTaskIds: [...lockedIds],
  });

  return ok({
    stageId: stage.id,
    existingTasks,
    nextVersion,
    actualMinutesToday,
    diff,
    previewToken: tokens.previewToken,
    snapshotId: tokens.snapshotId,
    actions: replan.actions,
    newTasks: replan.newTasks,
    scheduledRetestIds: replan.scheduledRetestIds,
  });
}

/**
 * 重排预览（dry-run，零写库）。
 *
 * @param input 计划日 / 新预算 / 是否休息日 / 锁定任务
 */
export async function previewReplan(
  input: ReplanPreviewInput,
): Promise<ActionResult<ReplanPreviewResult>> {
  const run = await runReplan(input);
  if (!run.ok) return fail(run.code, run.error);
  return ok({
    diff: run.data.diff,
    previewToken: run.data.previewToken,
    snapshotId: run.data.snapshotId,
  });
}

/**
 * 确认重排：重算 token → 校验 → 空版本拦截 → 幂等拦截 → 一次事务落库。
 *
 * @param input 预览输入 + 预览令牌 + 幂等键
 */
export async function confirmReplan(
  input: ConfirmReplanInput,
): Promise<ActionResult<{ version: number; applied: ReplanDiff['summary'] }>> {
  const run = await runReplan(input);
  if (!run.ok) return fail(run.code, run.error);
  const {
    stageId,
    existingTasks,
    nextVersion,
    actualMinutesToday,
    diff,
    previewToken,
    snapshotId,
    actions,
    newTasks,
    scheduledRetestIds,
  } = run.data;

  if (previewToken !== input.previewToken) {
    return fail('CONFLICT', '计划在预览后已变化，请刷新预览再确认');
  }
  if (!diff.hasChanges) {
    return fail('PRECONDITION', '没有可确认的变更（计划未变），禁止生成空版本');
  }

  const already = await prisma.planVersion.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  if (already) return fail('CONFLICT', '该预览已确认过，请刷新预览再确认');

  const moduleById = new Map(existingTasks.map((task) => [task.id, task.module]));
  const beforeSnapshot = JSON.stringify(
    existingTasks.map((task) => ({
      id: task.id,
      module: task.module,
      plannedMinutes: task.plannedMinutes,
      actualMinutes: task.actualMinutes,
      status: task.status,
    })),
  );
  const afterSnapshot = JSON.stringify({ summary: diff.summary, entries: diff.entries });

  // 主材料映射是只读查询，必须在事务外取：事务内调全局 prisma 会另开连接，SQLite 死锁。
  const resourceMap = newTasks.length > 0 ? await primaryResourceMap() : {};

  await prisma.$transaction(async (tx) => {
    // 逐条执行 replan 指令（与 v2.1 replan action 同口径）。
    for (const action of actions) {
      if (action.type === 'SHRINK') {
        await tx.planTask.update({
          where: { id: action.taskId },
          data: {
            plannedMinutes: action.newPlannedMinutes,
            rescheduleReason: input.reason ?? '预算变更后重新规划',
          },
        });
      } else if (action.type === 'DEFER') {
        await tx.planTask.update({
          where: { id: action.taskId },
          data: {
            status: 'DEFERRED',
            statusChangedAt: new Date(),
            deferReason: action.reason,
            rescheduleReason: input.reason ?? '预算变更后重新规划',
          },
        });
        // 复测任务被延期：解除排期关联，让它能重新进入下一次生成/重排。
        if (moduleById.get(action.taskId) === 'EVIDENCE_RETEST') {
          await tx.retestSchedule.updateMany({
            where: { planTaskId: action.taskId },
            data: { planTaskId: null },
          });
        }
      }
      // KEEP：无写入。
    }

    // 批量创建新任务（不删除旧任务，保护 StudySession 级联）。
    if (newTasks.length > 0) {
      await tx.planTask.createMany({
        data: newTasks.map((spec) => ({
          stageId,
          planDate: input.planDate,
          module: spec.module,
          skill: spec.skill,
          plannedMinutes: spec.plannedMinutes,
          actualMinutes: 0,
          status: 'TODO',
          sortOrder: spec.sortOrder,
          track: spec.track,
          primarySkill: spec.primarySkill,
          priority: spec.priority,
          sourceKind: spec.sourceKind,
          splittable: spec.splittable,
          minChunkMinutes: spec.minChunkMinutes,
          planVersion: spec.planVersion,
          originalScheduledDate: input.planDate,
          rescheduleReason: input.reason ?? '预算变更后重新规划',
          resourceId: SKILL_TO_SUBJECT[spec.skill]
            ? (resourceMap[SKILL_TO_SUBJECT[spec.skill] as string] ?? null)
            : null,
          note: spec.rationale,
        })),
      });

      // v2.2：重排新增的复测任务同样要回写排期关联。
      if (scheduledRetestIds.length > 0) {
        const retestTask = await tx.planTask.findFirst({
          where: { planDate: input.planDate, planVersion: nextVersion, module: 'EVIDENCE_RETEST' },
          select: { id: true },
        });
        if (retestTask) {
          await tx.retestSchedule.updateMany({
            where: { id: { in: scheduledRetestIds }, status: 'PENDING' },
            data: { planTaskId: retestTask.id },
          });
        }
      }
    }

    // 写一条 REPLAN 版本（幂等键唯一，token 失效则到不了这里）。
    await tx.planVersion.create({
      data: {
        planDate: input.planDate,
        version: nextVersion,
        changeSource: 'REPLAN',
        reason: input.reason ?? '预算变更后重新规划',
        budgetMinutes: input.newBudgetMinutes,
        actualMinutesAtChange: actualMinutesToday,
        beforeSnapshot,
        afterSnapshot,
        idempotencyKey: input.idempotencyKey,
        snapshotId,
      },
    });
  });

  return ok({ version: nextVersion, applied: diff.summary });
}
