/**
 * v2.7 T08 重排 diff —— 纯函数（无 IO，只做前后对比，不做决策）。
 *
 * `diffPlan()` 拿「重排前」与「重排后」两组行做对比，产出六类差异：
 * ADD / REMOVE / MOVE / RESIZE / PRIORITY_CHANGE / KEEP。
 *
 * 稳定行键约定（`41 §2.7`）：既有任务用 `taskId`，新增任务用调用方给定的键
 * （`replanPreview` 里新任务没有 candidateKey，用 `new:{sortOrder}` 兜底）。
 *
 * 复用关系：这里**不**调用 `replanDailyTasks()`，也不做任何裁决 —— 决策早已在
 * `domain/replan.ts` 完成，diff 只负责把它翻译成 UI 能渲染的条目。
 */

import type { ModuleId, TaskPriority } from '../types';

/** 单条 diff 条目。 */
export interface ReplanDiffEntry {
  kind: 'ADD' | 'REMOVE' | 'MOVE' | 'RESIZE' | 'PRIORITY_CHANGE' | 'KEEP';
  /** 稳定行键：既有任务用 taskId，新增用调用方给定的键。 */
  key: string;
  title: string;
  before: { date: string; minutes: number; priority: TaskPriority; module: ModuleId } | null;
  after: { date: string; minutes: number; priority: TaskPriority; module: ModuleId } | null;
  /** 必填，人话。来自 `replan.ts` 的 `ReplanAction.reason` / 新任务的 rationale。 */
  reason: string;
  /** 已完成 / 计时中的行：受保护，不参与变更。 */
  protected: boolean;
}

export interface ReplanDiff {
  planDate: string;
  entries: ReplanDiffEntry[];
  summary: {
    plannedBefore: number;
    plannedAfter: number;
    budget: number;
    budgetBefore: number;
    addedCount: number;
    removedCount: number;
    movedCount: number;
    resizedCount: number;
    priorityChangedCount: number;
    keptCount: number;
    p0MinutesBefore: number;
    p0MinutesAfter: number;
    protectedMinutes: number;
    /** 被挤出到 backlog 的分钟（取自 `replan.ts` 的 `BacklogItem`）。 */
    backlogMinutes: number;
  };
  warnings: string[];
  /** 是否有任何差异；false → UI 禁用「确认重排」按钮（PRD §4.7 空态）。 */
  hasChanges: boolean;
}

/** diff 的一行输入。`protected` 只对 `before` 行有意义。 */
export interface DiffRow {
  key: string;
  title: string;
  date: string;
  minutes: number;
  priority: TaskPriority;
  module: ModuleId;
  reason: string;
  protected?: boolean;
}

export interface DiffPlanInput {
  planDate: string;
  /** 重排目标预算（新预算）。 */
  budgetMinutes: number;
  /** 重排前生效的预算。 */
  budgetBeforeMinutes: number;
  before: DiffRow[];
  after: DiffRow[];
  backlogMinutes: number;
  warnings: string[];
}

/** 行 → 展示形状（去掉 `reason`/`protected` 两个 diff 专用字段）。 */
function snapshotOf(row: DiffRow): NonNullable<ReplanDiffEntry['before']> {
  return { date: row.date, minutes: row.minutes, priority: row.priority, module: row.module };
}

/**
 * 纯 diff：对比 before / after 两组行。
 *
 * @param input 计划日 / 预算 / 前后行 / backlog 分钟 / 警告
 */
export function diffPlan(input: DiffPlanInput): ReplanDiff {
  const beforeByKey = new Map(input.before.map((row) => [row.key, row]));
  const afterByKey = new Map(input.after.map((row) => [row.key, row]));

  // 顺序：before 原顺序在前，纯新增（after-only）按 after 顺序补在末尾 —— 确定性输出。
  const keys = [
    ...input.before.map((row) => row.key),
    ...input.after.filter((row) => !beforeByKey.has(row.key)).map((row) => row.key),
  ];

  const entries: ReplanDiffEntry[] = [];
  for (const key of keys) {
    const before = beforeByKey.get(key) ?? null;
    const after = afterByKey.get(key) ?? null;
    if (!before && !after) continue;

    let kind: ReplanDiffEntry['kind'];
    if (!before && after) kind = 'ADD';
    else if (before && !after) kind = 'REMOVE';
    else if (before && after) {
      if (before.date !== after.date) kind = 'MOVE';
      else if (before.minutes !== after.minutes) kind = 'RESIZE';
      else if (before.priority !== after.priority) kind = 'PRIORITY_CHANGE';
      else kind = 'KEEP';
    } else {
      continue; // 不可达
    }

    entries.push({
      kind,
      key,
      title: (after?.title ?? before?.title ?? ''),
      before: before ? snapshotOf(before) : null,
      after: after ? snapshotOf(after) : null,
      reason: after?.reason ?? before?.reason ?? '',
      protected: before?.protected === true,
    });
  }

  const sumMinutes = (rows: DiffRow[]) => rows.reduce((sum, row) => sum + Math.max(0, row.minutes), 0);
  const countByKind = (kind: ReplanDiffEntry['kind']) =>
    entries.filter((entry) => entry.kind === kind).length;

  const plannedBefore = sumMinutes(input.before);
  const plannedAfter = sumMinutes(input.after);
  const p0MinutesBefore = input.before
    .filter((row) => row.priority === 'P0')
    .reduce((sum, row) => sum + Math.max(0, row.minutes), 0);
  const p0MinutesAfter = input.after
    .filter((row) => row.priority === 'P0')
    .reduce((sum, row) => sum + Math.max(0, row.minutes), 0);
  const protectedMinutes = input.before
    .filter((row) => row.protected)
    .reduce((sum, row) => sum + Math.max(0, row.minutes), 0);

  return {
    planDate: input.planDate,
    entries,
    summary: {
      plannedBefore,
      plannedAfter,
      budget: input.budgetMinutes,
      budgetBefore: input.budgetBeforeMinutes,
      addedCount: countByKind('ADD'),
      removedCount: countByKind('REMOVE'),
      movedCount: countByKind('MOVE'),
      resizedCount: countByKind('RESIZE'),
      priorityChangedCount: countByKind('PRIORITY_CHANGE'),
      keptCount: countByKind('KEEP'),
      p0MinutesBefore,
      p0MinutesAfter,
      protectedMinutes,
      backlogMinutes: input.backlogMinutes,
    },
    warnings: input.warnings,
    hasChanges: entries.some((entry) => entry.kind !== 'KEEP'),
  };
}
