/**
 * v2.1 中途重新规划 —— 纯函数。
 *
 * 场景：当天开始学习后可用预算发生变化（临时加班、家庭事务、身体状态等），
 * 需要在保留已发生学习记录的前提下，重新分配剩余时间。
 *
 * 硬约束（需求手册 §7.1 / §15.2 T08–T11）：
 * 1. 已完成（DONE）等已结束任务：不回滚、不重排，`plannedMinutes` 原样保留；
 * 2. **剩余预算 = 新预算 − 当天已发生净学习分钟**（预算剩余口径），
 *    而不是「新预算 − 保留任务的计划分钟」—— 后者会把已学时间重复计一次；
 * 3. 进行中的可拆分任务：从剩余预算里再分配「原计划 − 已发生」的尾巴，
 *    分不到就缩到 `actualMinutes`（不能低于已学时间）；
 * 4. 进行中的不可拆分任务：不能中途砍断，整体占用剩余预算；连它也放不下时
 *    仍保留并给出超预算警告（事实优先于计划）；
 * 5. 未开始任务：标记 `DEFERRED`，**绝不删除** —— `StudySession.taskId` 是
 *    `onDelete: Cascade`，删任务会连带抹掉计时历史；
 * 6. 新任务带自增 `planVersion`，与旧版本行形成审计分层。
 */

import { generateAdaptivePlan, type AdaptivePlanInput } from './adaptivePlan';
import type { ModuleId, TaskPriority, TaskSourceKind, TaskStatus } from '../types';

/** 待重排的一条现存任务快照。 */
export interface ExistingTask {
  id: string;
  module: string;
  skill: string;
  plannedMinutes: number;
  actualMinutes: number;
  status: TaskStatus;
  priority: TaskPriority;
  sourceKind: TaskSourceKind;
  splittable: boolean;
  minChunkMinutes: number;
  sortOrder: number;
  planVersion: number;
  movedToDate?: string | null;
  movedCount?: number;
  /** 该行计时器正在运行：不能改时长、不能延期，只能原样保留（否则会打断计时）。 */
  timerRunning?: boolean;
  timerStatus?: string;
  timerVersion?: number;
  track: string;
  primarySkill: string;
  resourceId: string | null;
  note: string | null;
}

/** 重排后的任务处置指令。 */
export type ReplanAction =
  | { type: 'KEEP'; taskId: string; reason: string }
  | { type: 'SHRINK'; taskId: string; newPlannedMinutes: number; reason: string }
  | { type: 'DEFER'; taskId: string; reason: string };

/** 新增任务（由自适应引擎重新生成）。 */
export interface NewTaskSpec {
  module: string;
  skill: string;
  plannedMinutes: number;
  sortOrder: number;
  track: string;
  primarySkill: string;
  priority: TaskPriority;
  sourceKind: TaskSourceKind;
  splittable: boolean;
  minChunkMinutes: number;
  rationale: string;
  planVersion: number;
}

export interface BacklogItem {
  kind: string;
  label: string;
  minutes: number;
  reason: string;
}

export interface ReplanInput {
  existingTasks: ExistingTask[];
  /** 新的当日预算（分钟，0 = 休息日）。 */
  newBudgetMinutes: number;
  isRestDay?: boolean;
  /** 自适应引擎的其余输入（阶段、配比、弱项、到期复习…）。 */
  planInput: Omit<AdaptivePlanInput, 'budgetMinutes' | 'isRestDay'>;
  /** 新版本号（当日 max(version) + 1）。 */
  nextVersion: number;
  /**
   * 当日已发生净学习分钟的权威值（Σ DaySplit）。
   * 传了就以它为准 —— 它包含不挂任务的学习段（如英语媒介学习），
   * 只按任务行求和会漏掉这部分，导致剩余预算被高估。
   */
  actualMinutesToday?: number;
}

export interface ReplanResult {
  ok: true;
  actions: ReplanAction[];
  newTasks: NewTaskSpec[];
  backlog: BacklogItem[];
  warnings: string[];
  /** 当日已发生净学习分钟（审计用，重排不会改动它）。 */
  actualMinutesSnapshot: number;
  /** 分给「进行中任务尾巴」后真正留给新任务的分钟数。 */
  remainingBudgetMinutes: number;
  /** 重排后计划总分钟（保留行 planned + 新任务 planned），仅用于展示。 */
  plannedAfterReplan: number;
  /** 新任务中已排入的到期复测（调用方据此回写 RetestSchedule.planTaskId）。 */
  scheduledRetestIds: string[];
}

export type ReplanError = { ok: false; code: 'INVALID_BUDGET'; error: string };

/** 已结束的状态：不参与重排，只有实际时长参与预算核算。 */
const CLOSED_STATUSES: TaskStatus[] = ['DONE', 'PARTIAL'];

/**
 * 中途重新规划。
 *
 * 计算顺序（不可调换，否则会重复计预算或砍掉已学时间）：
 * ① 已发生净学习分钟 → 剩余预算 = 新预算 − 已发生；
 * ② 已结束任务：KEEP，不占剩余预算（它们的时长已在 ① 抵扣）；
 * ③ 进行中不可拆分：整体保留，从剩余预算里扣「计划 − 已发生」；
 * ④ 进行中可拆分：从剩余预算里补「计划 − 已发生」的尾巴，不够就缩到已发生；
 * ⑤ 未开始：DEFER；
 * ⑥ 剩余预算交给自适应引擎生成新任务。
 */
export function replanDailyTasks(input: ReplanInput): ReplanResult | ReplanError {
  const { existingTasks, newBudgetMinutes, isRestDay, planInput, nextVersion } = input;

  const budget = Math.round(newBudgetMinutes);
  if (!Number.isFinite(budget) || budget < 0) {
    return { ok: false, code: 'INVALID_BUDGET', error: '预算必须为非负整数' };
  }

  const warnings: string[] = [];
  const backlog: BacklogItem[] = [];
  const actions: ReplanAction[] = [];

  // ① 已发生净学习分钟 —— 这是唯一必须尊重的「事实」
  const taskActualMinutes = existingTasks.reduce(
    (sum, task) => sum + Math.max(0, task.actualMinutes),
    0,
  );
  const actualMinutesSnapshot =
    typeof input.actualMinutesToday === 'number' && Number.isFinite(input.actualMinutesToday)
      ? Math.max(0, Math.round(input.actualMinutesToday))
      : taskActualMinutes;
  let remaining = budget - actualMinutesSnapshot;

  // ② 已结束任务：原样保留
  const closed = existingTasks.filter((task) => CLOSED_STATUSES.includes(task.status));
  for (const task of closed) {
    actions.push({ type: 'KEEP', taskId: task.id, reason: '已结束，保留原样，不重新排程' });
  }

  // ③ 进行中的任务。状态仍是 TODO 但已有实际时长的行（计时后被改回 TODO 的历史数据）
  //    同样按进行中处理 —— 它的未完成尾巴要占预算，否则新任务会超排。
  const isActive = (task: ExistingTask) =>
    task.status === 'IN_PROGRESS' || (task.status === 'TODO' && task.actualMinutes > 0);
  const active = existingTasks.filter(isActive);
  for (const task of active) {
    const done = Math.max(0, task.actualMinutes);
    const tail = Math.max(0, task.plannedMinutes - done);

    if (task.timerRunning) {
      // 计时进行中：改 plannedMinutes 会让「本次计划」在计时中途漂移，直接冻结
      actions.push({
        type: 'KEEP',
        taskId: task.id,
        reason: '计时进行中，冻结计划不变（先暂停或结束计时再重排）',
      });
      warnings.push('有任务正在计时，本次未调整其时长；如需重排请先暂停计时。');
      // 冻结的计划尾巴仍然占用剩余预算，否则新任务会超排
      remaining -= tail;
      continue;
    }

    if (!task.splittable) {
      // 不可拆分：不能中途砍断，整体保留；放不下也要保留并提示
      actions.push({
        type: 'KEEP',
        taskId: task.id,
        reason: `进行中且不可拆分，保留原计划（已发生 ${done} / 计划 ${task.plannedMinutes} 分钟）`,
      });
      remaining -= tail;
      continue;
    }

    const allocate = Math.min(tail, Math.max(0, remaining));
    if (allocate >= tail) {
      actions.push({
        type: 'KEEP',
        taskId: task.id,
        reason: `已完成 ${done} 分钟，剩余 ${tail} 分钟可全部保留`,
      });
    } else {
      actions.push({
        type: 'SHRINK',
        taskId: task.id,
        newPlannedMinutes: done + allocate,
        reason: `已完成 ${done} 分钟，剩余预算只够再排 ${allocate} 分钟（原需 ${tail} 分钟），尾巴转入 backlog`,
      });
      const lost = tail - allocate;
      if (lost > 0) {
        backlog.push({
          kind: 'PARTIAL_TAIL',
          label: `${task.skill} 未完部分`,
          minutes: lost,
          reason: '预算缩短后未排入；可在后续日期分段补完（任务可拆分）',
        });
      }
    }
    remaining -= allocate;
  }

  // ④ 未开始的 TODO：DEFER（不删除，保护 StudySession 级联）。
  //    CANCELLED / MISSED / DEFERRED 是已做出的决定：不产生任何指令，原状态与原因原样保留，
  //    也不计入「重排后计划总分钟」。
  const notStarted = existingTasks.filter(
    (task) => task.status === 'TODO' && task.actualMinutes <= 0,
  );
  for (const task of notStarted) {
    actions.push({
      type: 'DEFER',
      taskId: task.id,
      reason: '未开始，预算变更后由引擎重新生成，原任务保留为 DEFERRED',
    });
  }

  // ⑤ 超预算说明（已发生时长 > 新预算）
  if (remaining < 0) {
    warnings.push(
      `当日已发生 ${actualMinutesSnapshot} 分钟，超出新预算 ${budget} 分钟。已发生记录全部保留，本次不再新增任务。`,
    );
    remaining = 0;
  }

  // ⑥ 剩余预算交给自适应引擎
  const newTasks: NewTaskSpec[] = [];
  let scheduledRetestIds: string[] = [];
  if (isRestDay || budget === 0) {
    warnings.push('休息日 / 零预算：不生成学习任务，本次不计为学习失败。');
    const deferredMinutes = notStarted.reduce((sum, task) => sum + task.plannedMinutes, 0);
    if (deferredMinutes > 0) {
      backlog.push({
        kind: 'REST_DAY',
        label: '原计划任务',
        minutes: deferredMinutes,
        reason: '休息日不安排学习；原计划任务转入 backlog，次日按优先级重新排入',
      });
    }
  } else if (remaining > 0) {
    // 当日已做过 / 正在做的模块不再重复排，省下的时间流向其他内容
    const keptModules = [...closed, ...active].map((task) => task.module as ModuleId);
    const adaptive = generateAdaptivePlan({
      ...planInput,
      budgetMinutes: remaining,
      isRestDay: false,
      skipModules: [...(planInput.skipModules ?? []), ...keptModules],
    });
    if (!adaptive.ok) {
      return { ok: false, code: 'INVALID_BUDGET', error: '剩余预算无法生成有效计划' };
    }
    warnings.push(...adaptive.warnings);
    backlog.push(...adaptive.backlog);
    scheduledRetestIds = adaptive.scheduledRetestIds;

    const sortBase = Math.max(-1, ...existingTasks.map((task) => task.sortOrder)) + 1;
    adaptive.items.forEach((item, index) => {
      newTasks.push({
        module: item.module,
        skill: item.skill,
        plannedMinutes: item.minutes,
        sortOrder: sortBase + index,
        track: item.track,
        primarySkill: item.primarySkill,
        priority: item.priority,
        sourceKind: item.sourceKind,
        splittable: item.splittable,
        minChunkMinutes: item.minChunkMinutes,
        rationale: item.rationale,
        planVersion: nextVersion,
      });
    });
  } else if (budget > 0) {
    warnings.push('新预算已被已发生时长与进行中任务占满，不生成额外任务。');
  }

  const remainingBudgetMinutes = Math.max(0, remaining);

  return {
    ok: true,
    actions,
    newTasks,
    backlog,
    warnings,
    actualMinutesSnapshot,
    remainingBudgetMinutes,
    plannedAfterReplan: totalPlannedAfterReplan(actions, existingTasks, newTasks),
    scheduledRetestIds,
  };
}

/** 重排后的计划总分钟（保留 + 缩减 + 新增），仅用于展示与校验。 */
export function totalPlannedAfterReplan(
  actions: ReplanAction[],
  existingTasks: ExistingTask[],
  newTasks: NewTaskSpec[],
): number {
  const taskMap = new Map(existingTasks.map((task) => [task.id, task]));
  let total = 0;
  for (const action of actions) {
    const task = taskMap.get(action.taskId);
    if (!task) continue;
    if (action.type === 'KEEP') total += task.plannedMinutes;
    else if (action.type === 'SHRINK') total += action.newPlannedMinutes;
  }
  total += newTasks.reduce((sum, task) => sum + Math.max(0, task.plannedMinutes), 0);
  return total;
}
