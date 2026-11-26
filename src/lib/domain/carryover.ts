/**
 * v2.7 T08 过载保护 —— 纯函数（无 IO）。
 *
 * 职责：对「逾期仍未完成」的任务逐条给出四类裁决，并做单日上限裁剪。
 * 判定顺序（`41 §2.8` C1–C7）不可调换：先命中先返回。
 *
 * 注意：本文件只做**决策**，不写库。写回 `PlanTask` 的职责在
 * `services/carryoverApply.ts`（与 `replan` 的分工见 T08 风险③：
 * **先 carryover 决策，再 replan**，carryover 的产物作为 replan 的输入）。
 */

import { createHash } from 'node:crypto';
import { MAX_MOVE_COUNT } from '../constants';
import { diffDays } from '../date';
import type { ModuleId, TaskPriority, TaskStatus } from '../types';

/** 一条待滚存的逾期任务。`status` 只接受 TODO / IN_PROGRESS / MISSED / DEFERRED。 */
export interface OverdueTask {
  taskId: string;
  module: ModuleId;
  priority: TaskPriority;
  plannedMinutes: number;
  actualMinutes: number;
  status: TaskStatus;
  planDate: string;
  originalScheduledDate?: string | null;
  planVersion?: number;
  movedCount: number;
  splittable: boolean;
  minChunkMinutes: number;
  deferReason: string | null;
  timerStatus?: string;
  timerVersion?: number;
  movedToDate?: string | null;
}

/** 四类裁决。`PROMOTE` / `DEMOTE` 会把任务滚入目标日，`BACKLOG` / `ABANDON` 不滚入。 */
export type CarryoverVerdict =
  | { action: 'PROMOTE'; toPriority: TaskPriority; reason: string }
  | { action: 'DEMOTE'; toPriority: TaskPriority; reason: string }
  | { action: 'BACKLOG'; reason: string }
  | { action: 'ABANDON'; reason: string };

export interface CarryoverInput {
  asOfDate: string;
  overdue: OverdueTask[];
  budgetMinutes: number;
  /** 单日滚存条数上限，默认 3。 */
  maxPerDay?: number;
  /** 单日滚存分钟上限（不超过预算的该比例），默认 0.25。 */
  maxMinutesRatio?: number;
  /** 顺延次数上限，默认复用 `MAX_MOVE_COUNT`（2）。 */
  ruleMaxMoves?: number;
}

export interface CarryoverResult {
  decisions: { taskId: string; verdict: CarryoverVerdict; overdueDays: number }[];
  promotedCount: number;
  demotedCount: number;
  backlogCount: number;
  abandonedCount: number;
  /** 被单日上限挤出的条数（也进 BACKLOG，但原因不同）。 */
  overflowCount: number;
  warnings: string[];
}

export interface CarryoverDecisionView {
  taskId: string;
  module: ModuleId;
  originalDate: string;
  previousPlanDate: string;
  previousPlanVersion: number;
  previousPriority: TaskPriority;
  finalPriority: TaskPriority | null;
  plannedMinutes: number;
  actualMinutes: number;
  remainingMinutes: number;
  movedCount: number;
  splittable: boolean;
  minChunkMinutes: number;
  overdueDays: number;
  action: CarryoverVerdict['action'];
  reason: string;
  destination: string;
}

export interface CarryoverPreview {
  asOfDate: string;
  budgetMinutes: number;
  fingerprint: string;
  decisions: CarryoverDecisionView[];
  promotedCount: number;
  demotedCount: number;
  backlogCount: number;
  abandonedCount: number;
  overflowCount: number;
  warnings: string[];
}

export function carryoverTaskFingerprint(tasks: readonly OverdueTask[]): string {
  const canonical = tasks
    .map((task) => ({
      taskId: task.taskId,
      module: task.module,
      planDate: task.planDate,
      originalScheduledDate: task.originalScheduledDate ?? task.planDate,
      planVersion: task.planVersion ?? null,
      priority: task.priority,
      movedCount: task.movedCount,
      splittable: task.splittable,
      plannedMinutes: task.plannedMinutes,
      actualMinutes: task.actualMinutes,
      minChunkMinutes: task.minChunkMinutes,
      deferReason: task.deferReason,
      status: task.status,
      timerStatus: task.timerStatus ?? 'IDLE',
      timerVersion: task.timerVersion ?? 0,
      movedToDate: task.movedToDate ?? null,
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

const PRIORITY_RANK: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 裁剪排序用：PROMOTE（优先补做）排在 DEMOTE（雪球控制）之前。 */
function urgencyRank(verdict: CarryoverVerdict): number {
  return verdict.action === 'PROMOTE' ? 0 : 1;
}

interface DecisionDraft {
  taskId: string;
  verdict: CarryoverVerdict;
  overdueDays: number;
  plannedMinutes: number;
  priority: TaskPriority;
}

/**
 * 过载保护裁决。
 *
 * @param input 基准日 / 逾期任务 / 当日预算 / 上限参数
 */
export function carryoverPolicy(input: CarryoverInput): CarryoverResult {
  const maxPerDay = input.maxPerDay ?? 3;
  const maxMinutesRatio = input.maxMinutesRatio ?? 0.25;
  const ruleMaxMoves = input.ruleMaxMoves ?? MAX_MOVE_COUNT;
  const budgetMinutes = Math.max(0, Math.round(input.budgetMinutes));

  const drafts: DecisionDraft[] = [];

  for (const task of input.overdue) {
    if (!['TODO', 'IN_PROGRESS', 'MISSED', 'DEFERRED'].includes(task.status)) continue;
    const done = Math.max(0, Math.round(task.actualMinutes));
    if (done >= Math.max(0, Math.round(task.plannedMinutes))) continue;
    const overdueDays = Math.max(0, diffDays(task.planDate, input.asOfDate));
    const plannedMinutes = Math.max(0, Math.round(task.plannedMinutes) - done);

    // C1：顺延次数已达上限 → 放弃
    if (task.movedCount >= ruleMaxMoves) {
      drafts.push({
        taskId: task.taskId,
        verdict: {
          action: 'ABANDON',
          reason: `已顺延 ${task.movedCount} 次达上限，建议放弃或拆成更小任务`,
        },
        overdueDays,
        plannedMinutes,
        priority: task.priority,
      });
      continue;
    }

    // C2：P0 逾期 ≤3 天 → 升格补做
    if (task.priority === 'P0' && overdueDays <= 3) {
      drafts.push({
        taskId: task.taskId,
        verdict: {
          action: 'PROMOTE',
          toPriority: 'P0',
          reason: `到期复习逾期 ${overdueDays} 天，优先补做`,
        },
        overdueDays,
        plannedMinutes,
        priority: task.priority,
      });
      continue;
    }

    // C3：P0 逾期 >3 天 → 降格到 P1（避免复习雪球）
    if (task.priority === 'P0' && overdueDays > 3) {
      drafts.push({
        taskId: task.taskId,
        verdict: {
          action: 'DEMOTE',
          toPriority: 'P1',
          reason: `复习已逾期 ${overdueDays} 天；先做当日到期项，避免复习雪球`,
        },
        overdueDays,
        plannedMinutes,
        priority: task.priority,
      });
      continue;
    }

    // C4：可拆分且做了一半 → 升格回原级，补齐尾巴
    if (task.splittable && task.actualMinutes > 0 && task.actualMinutes < task.plannedMinutes) {
      const done = Math.max(0, Math.round(task.actualMinutes));
      const planned = Math.max(0, Math.round(task.plannedMinutes));
      const remaining = planned - done;
      drafts.push({
        taskId: task.taskId,
        verdict: {
          action: 'PROMOTE',
          toPriority: task.priority,
          reason: `已完成 ${done}/${planned} 分钟，先补完剩余 ${remaining} 分钟`,
        },
        overdueDays,
        plannedMinutes,
        priority: task.priority,
      });
      continue;
    }

    // C5：整块不可拆且已顺延过 → backlog（建议拆段）
    if (!task.splittable && task.movedCount >= 1) {
      drafts.push({
        taskId: task.taskId,
        verdict: {
          action: 'BACKLOG',
          reason: `整块任务连续未完成；建议拆成 ≥${task.minChunkMinutes} 分钟的段`,
        },
        overdueDays,
        plannedMinutes,
        priority: task.priority,
      });
      continue;
    }

    // C6：P1 / P2 → backlog（按周轮换摊平）
    if (task.priority === 'P1' || task.priority === 'P2') {
      drafts.push({
        taskId: task.taskId,
        verdict: {
          action: 'BACKLOG',
          reason: '进入 backlog，按周轮换摊平，不占用今日 P0/P1',
        },
        overdueDays,
        plannedMinutes,
        priority: task.priority,
      });
      continue;
    }

    // C7：其余（P3 拓展）→ 放弃
    drafts.push({
      taskId: task.taskId,
      verdict: { action: 'ABANDON', reason: '拓展任务过期即放弃，不滚存' },
      overdueDays,
      plannedMinutes,
      priority: task.priority,
    });
  }

  // ── 单日上限：只裁剪 PROMOTE / DEMOTE，按 urgency → priority → overdueDays 取前 N ──
  // `OverdueTask` 没有显式 `urgency` 字段，这里把裁决动作的紧迫度当作第一键：
  // 优先补做（PROMOTE）> 降级缓做（DEMOTE）。
  const schedulable = drafts.filter(
    (draft) => draft.verdict.action === 'PROMOTE' || draft.verdict.action === 'DEMOTE',
  );
  schedulable.sort(
    (a, b) =>
      urgencyRank(a.verdict) - urgencyRank(b.verdict) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      b.overdueDays - a.overdueDays ||
      a.taskId.localeCompare(b.taskId),
  );

  let kept = 0;
  let keptMinutes = 0;
  let overflowCount = 0;
  const minutesCap = budgetMinutes * maxMinutesRatio;

  for (const draft of schedulable) {
    if (kept >= maxPerDay) {
      draft.verdict = { action: 'BACKLOG', reason: `单日滚存上限 ${maxPerDay} 条` };
      overflowCount += 1;
    } else if (keptMinutes + draft.plannedMinutes > minutesCap) {
      draft.verdict = { action: 'BACKLOG', reason: `滚存分钟超过预算 ${maxMinutesRatio}` };
      overflowCount += 1;
    } else {
      kept += 1;
      keptMinutes += draft.plannedMinutes;
    }
  }

  let promotedCount = 0;
  let demotedCount = 0;
  let backlogCount = 0;
  let abandonedCount = 0;
  for (const draft of drafts) {
    if (draft.verdict.action === 'PROMOTE') promotedCount += 1;
    else if (draft.verdict.action === 'DEMOTE') demotedCount += 1;
    else if (draft.verdict.action === 'BACKLOG') backlogCount += 1;
    else abandonedCount += 1;
  }

  const warnings: string[] = [];
  if (overflowCount > 0) {
    warnings.push(`${overflowCount} 项任务因过载上限进入 backlog`);
  }

  return {
    decisions: drafts.map((draft) => ({
      taskId: draft.taskId,
      verdict: draft.verdict,
      overdueDays: draft.overdueDays,
    })),
    promotedCount,
    demotedCount,
    backlogCount,
    abandonedCount,
    overflowCount,
    warnings,
  };
}
