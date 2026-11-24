/**
 * v2.7 T06b（Q6）：**全系统唯一写 `PlanTask` 的函数**。
 *
 * 为什么只能有一个写入者（`40 §3` / `41 §2.5`）：
 * 材料草案确认、候选确认、手工加任务三个入口，过去各自写 `PlanTask`，于是
 * ① 预算闸门在材料入口跑、手工入口不跑（同一天可从两条路超支）；
 * ② `planVersion` / `sourceKind` / `splittable` 的推导各写一份，迟早漂移；
 * ③ 幂等（草案重复确认）只在一个入口有，另一个入口能写出两条。
 * 现在三个入口全部收敛到 `appendTaskFromCandidate()`，事务边界、预算闸门、
 * 字段推导、版本审计都只有这一处。
 *
 * 硬约束（G-13 扫描守着）：
 * - `sourceKind` **只接受映射后的 `TaskSourceKind`**，函数内不 import 候选域枚举、
 *   不重写 `mapCandidateSourceToPlanTask`；调用点必须传映射结果。
 * - `priority` / `sourceKind` 必填、无默认值：让"忘了传"编译不过，而不是静默
 *   写成 `P1`/`CORE`（那正是 Q6 要消灭的旧行为）。
 * - 预算闸门**只跑一次**，在事务内；调用方不得预扣（否则双重拒绝）。
 * - 幂等命中时**零写入**（连 PlanVersion 也不建）。
 */

import { MIN_TASK_MINUTES } from '@/lib/constants';
import {
  describeBudgetViolations,
  validateProposalAgainstBudget,
  type BudgetDay,
} from '@/lib/domain/taskProposal';
import { prisma } from '@/lib/prisma';
import { getEffectiveBudget } from '@/lib/queries/budget';
import { nextPlanVersion } from '@/lib/queries/planning';
import { fail, ok } from '@/lib/result';
import type {
  ActionResult,
  LearningTrack,
  ModuleId,
  PrimarySkill,
  SkillId,
  TaskPriority,
  TaskSourceKind,
} from '@/lib/types';

/** 写入来源 → `PlanVersion.changeSource` 与审计原因（不新增枚举，复用 v2.1 三值）。 */
type WriteOrigin = 'MATERIAL_CONFIRM' | 'CANDIDATE_CONFIRM' | 'MANUAL_ADD';

const ORIGIN_AUDIT: Record<
  WriteOrigin,
  { changeSource: 'GENERATE' | 'MANUAL_ADJUST' | 'REPLAN'; reason: string }
> = {
  // 材料草案是用户勾选后落地的 → 语义上是"人工调整"；不新增 changeSource 枚举
  MATERIAL_CONFIRM: { changeSource: 'MANUAL_ADJUST', reason: '材料草案确认写入计划' },
  CANDIDATE_CONFIRM: { changeSource: 'GENERATE', reason: '候选任务确认写入计划' },
  MANUAL_ADD: { changeSource: 'MANUAL_ADJUST', reason: '手工新增任务' },
};

export interface AppendTaskFromCandidateInput {
  stageId: string;
  /** `YYYY-MM-DD`。 */
  planDate: string;
  module: ModuleId;
  /** 由 `taskAxesOf(module, candidate.targetSkill)` 产出，调用点不要自己算。 */
  skill: SkillId;
  plannedMinutes: number;
  /** 必填：来自 `TaskPriorityDecision.priority`，禁止函数内写死默认值。 */
  priority: TaskPriority;
  /** 必填：来自 `mapCandidateSourceToPlanTask()`，禁止直接传候选域的 sourceKind。 */
  sourceKind: TaskSourceKind;
  track: LearningTrack;
  primarySkill: PrimarySkill;
  /** 不传则取 `MIN_TASK_MINUTES`。 */
  minChunkMinutes?: number;
  resourceId?: string | null;
  note?: string | null;
  /** 溯源：选中的候选 id。 */
  candidateId?: string | null;
  /** JSON：当时的优先级决策快照。 */
  decisionJson?: string | null;
  /** 幂等：材料草案确认必传（`TaskProposalItem.id`）。 */
  proposalItemId?: string | null;
  /** 幂等：其他入口可传（同 key 重放返回已有结果）。 */
  idempotencyKey?: string | null;
  /** 审计用：决定 `PlanVersion.changeSource` / `reason`。 */
  origin: WriteOrigin;
  /**
   * 整批确认入口专用：调用方已用 `validateBatchBudget()` 校验过**整批**条目且通过，
   * 本条写入跳过重复校验。默认 false（单条入口必须自己校验）。
   *
   * 只有 materialPack 的「草案确认」这类"多条原子提交"入口才可传 true，
   * 且必须先跑完 `validateBatchBudget()` —— 否则会写出超预算任务。
   */
  budgetPrevalidated?: boolean;
}

export interface AppendTaskFromCandidateResult {
  taskId: string;
  planVersion: number;
  /** false = 幂等命中，未新建。 */
  created: boolean;
  splittable: boolean;
  /** 该日写入后的计划总分钟（供调用方展示）。 */
  plannedMinutesAfter: number;
  warnings: string[];
}

/** 当日有效任务（进入预算占用）的状态排除集，与完成率口径同源。 */
const BUDGET_EXCLUDED_STATUSES = ['CANCELLED', 'DEFERRED'] as const;

/**
 * 整批预算预检（materialPack 草案确认专用）：一次校验多条待写条目，
 * 超支则整批拒绝，保持 v2.6「确认是承诺，有超支一条都不写」的语义。
 *
 * 与写入者内部的单条闸门共用同一个纯函数 `validateProposalAgainstBudget`，
 * 口径不会分叉；入口跑过本函数后，逐条写入时传 `budgetPrevalidated:true`
 * 跳过重复校验，保证整批确认中预算闸门**总共只跑一次**（Q6 硬约束，spy 可验）。
 */
export function validateBatchBudget(
  items: readonly { date: string; minutes: number }[],
  days: readonly BudgetDay[],
): ActionResult<{ violations: ReturnType<typeof validateProposalAgainstBudget>['violations'] }> {
  const check = validateProposalAgainstBudget(items, days);
  if (!check.ok) {
    return fail('PRECONDITION', describeBudgetViolations(check.violations));
  }
  return ok({ violations: check.violations });
}

/**
 * 全系统唯一的 `PlanTask` 写入者。函数自己开事务，调用方不得再嵌套。
 *
 * 幂等命中返回 `created:false`，此时 `taskId` 指向已有任务、`planVersion` 为其版本。
 * 预算超支返回 `PRECONDITION` 且**零写入**（事务回滚）。
 */
export async function appendTaskFromCandidate(
  input: AppendTaskFromCandidateInput,
): Promise<ActionResult<AppendTaskFromCandidateResult>> {
  const minChunkMinutes = input.minChunkMinutes ?? MIN_TASK_MINUTES;
  const splittable = input.plannedMinutes > minChunkMinutes;
  const audit = ORIGIN_AUDIT[input.origin];

  try {
    const result = await prisma.$transaction(async (tx) => {
      // ── 1. 幂等前置（读） ──
      if (input.proposalItemId) {
        const item = await tx.taskProposalItem.findUnique({
          where: { id: input.proposalItemId },
          select: { planTaskId: true },
        });
        if (item?.planTaskId) {
          const existing = await tx.planTask.findUnique({
            where: { id: item.planTaskId },
            select: { planVersion: true, plannedMinutes: true },
          });
          const daySum = await tx.planTask.aggregate({
            where: {
              planDate: input.planDate,
              status: { notIn: [...BUDGET_EXCLUDED_STATUSES] },
            },
            _sum: { plannedMinutes: true },
          });
          return {
            created: false,
            taskId: item.planTaskId,
            planVersion: existing?.planVersion ?? 1,
            splittable: existing ? existing.plannedMinutes > minChunkMinutes : splittable,
            plannedMinutesAfter: daySum._sum.plannedMinutes ?? 0,
            warnings: [] as string[],
          };
        }
      }

      if (input.idempotencyKey) {
        const hit = await tx.planVersion.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { version: true },
        });
        if (hit) {
          const existingTask = await tx.planTask.findFirst({
            where: { planDate: input.planDate, planVersion: hit.version },
            orderBy: { sortOrder: 'asc' },
            select: { id: true, plannedMinutes: true },
          });
          if (existingTask) {
            const daySum = await tx.planTask.aggregate({
              where: {
                planDate: input.planDate,
                status: { notIn: [...BUDGET_EXCLUDED_STATUSES] },
              },
              _sum: { plannedMinutes: true },
            });
            return {
              created: false,
              taskId: existingTask.id,
              planVersion: hit.version,
              splittable: existingTask.plannedMinutes > minChunkMinutes,
              plannedMinutesAfter: daySum._sum.plannedMinutes ?? 0,
              warnings: [] as string[],
            };
          }
        }
      }

      // ── 3. 预算闸门（整批确认已预检时跳过，否则在事务内跑唯一一次） ──
      // 当日已有任务的占用（排除 CANCELLED / DEFERRED） + 本次新增
      const dayExisting = await tx.planTask.aggregate({
        where: {
          planDate: input.planDate,
          status: { notIn: [...BUDGET_EXCLUDED_STATUSES] },
        },
        _sum: { plannedMinutes: true },
      });
      const existingMinutes = dayExisting._sum.plannedMinutes ?? 0;
      const budget = await getEffectiveBudget(input.planDate, tx);
      if (!input.budgetPrevalidated) {
        const days: BudgetDay[] = [
          { date: input.planDate, minutes: budget.minutes, isRestDay: budget.isRestDay },
        ];
        const check = validateProposalAgainstBudget(
          [{ date: input.planDate, minutes: existingMinutes + input.plannedMinutes }],
          days,
        );
        if (!check.ok) {
          // 抛错让事务回滚；外层 catch 转成 fail('PRECONDITION')。
          throw new BudgetGateError(describeBudgetViolations(check.violations));
        }
      }

      // ── 2/4. 版本与排序（在事务内取，避免并发下撞版本） ──
      const version = await nextPlanVersion(input.planDate, tx);
      const maxSort = await tx.planTask.aggregate({
        where: { planDate: input.planDate },
        _max: { sortOrder: true },
      });
      const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

      // 当日已发生净分钟（只读，不改）——与完成率同源，绝不从 activeMinutes 推算
      const netAgg = await tx.studySessionDaySplit.aggregate({
        where: { date: input.planDate },
        _sum: { minutes: true },
      });
      const actualMinutesAtChange = netAgg._sum.minutes ?? 0;

      // ── 5. 写 PlanTask（17 字段全量） ──
      const task = await tx.planTask.create({
        data: {
          stageId: input.stageId,
          planDate: input.planDate,
          module: input.module,
          skill: input.skill,
          plannedMinutes: input.plannedMinutes,
          sortOrder,
          track: input.track,
          primarySkill: input.primarySkill,
          priority: input.priority,
          sourceKind: input.sourceKind,
          splittable,
          minChunkMinutes,
          planVersion: version,
          originalScheduledDate: input.planDate,
          resourceId: input.resourceId ?? null,
          note: input.note ?? null,
          candidateId: input.candidateId ?? null,
          decisionJson: input.decisionJson ?? null,
        },
        select: { id: true },
      });

      // ── 6. 回填草案的 planTaskId（幂等键的落地点，同事务） ──
      if (input.proposalItemId) {
        await tx.taskProposalItem.update({
          where: { id: input.proposalItemId },
          data: { planTaskId: task.id },
        });
      }

      // ── 7. 同事务写 PlanVersion 审计 ──
      const plannedMinutesAfter = existingMinutes + input.plannedMinutes;
      await tx.planVersion.create({
        data: {
          planDate: input.planDate,
          version,
          changeSource: audit.changeSource,
          reason: audit.reason,
          budgetMinutes: budget.minutes,
          actualMinutesAtChange,
          afterSnapshot: JSON.stringify({
            taskId: task.id,
            taskCount: 1,
            addedMinutes: input.plannedMinutes,
            plannedMinutesAfter,
            sourceKind: input.sourceKind,
          }),
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      return {
        created: true,
        taskId: task.id,
        planVersion: version,
        splittable,
        plannedMinutesAfter,
        warnings: budget.isSuggestion ? ['该日尚无显式预算，使用了系统建议值'] : [],
      };
    });

    return ok(result);
  } catch (error) {
    if (error instanceof BudgetGateError) {
      return fail('PRECONDITION', error.message);
    }
    // 唯一约束冲突（并发重放同一 idempotencyKey）：当作幂等命中重试一次读取
    if (isUniqueConstraintError(error) && input.idempotencyKey) {
      const hit = await prisma.planVersion.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { version: true },
      });
      if (hit) {
        const existingTask = await prisma.planTask.findFirst({
          where: { planDate: input.planDate, planVersion: hit.version },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, plannedMinutes: true },
        });
        if (existingTask) {
          const daySum = await prisma.planTask.aggregate({
            where: {
              planDate: input.planDate,
              status: { notIn: [...BUDGET_EXCLUDED_STATUSES] },
            },
            _sum: { plannedMinutes: true },
          });
          return ok({
            taskId: existingTask.id,
            planVersion: hit.version,
            created: false,
            splittable: existingTask.plannedMinutes > minChunkMinutes,
            plannedMinutesAfter: daySum._sum.plannedMinutes ?? 0,
            warnings: [],
          });
        }
      }
    }
    throw error;
  }
}

/** 预算闸门失败信号：事务内抛出以触发回滚，事务外 catch 转成 `ActionResult`。 */
class BudgetGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetGateError';
  }
}

/** Prisma 唯一约束错误（P2002）——只用于并发幂等兜底。 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
