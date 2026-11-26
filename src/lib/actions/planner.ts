'use server';

/**
 * 规划器（v2.7）的 Server Actions —— T07 先落 5 个。
 *
 * 统一返回 `ActionResult`，失败不 throw；写操作后 `revalidatePath`。
 *
 * 预览与确认必须复用同一个 `snapshotId`（T07 风险①）：`generatePlanPreviewAction`
 * 只调 `buildPlan()`（零写 `PlanTask`/`PlanVersion`），把 `snapshotId + inputHash`
 * 签成 `previewToken` 交给前端；`confirmPlanVersionAction` 用同一个 `snapshotId`
 * 反查 `inputHash` 重算 token，不等 → `CONFLICT`。
 */

import { revalidatePath } from 'next/cache';
import { getBusinessTimezone } from '@/lib/businessTime';
import { prisma } from '@/lib/prisma';
import { addDays, listDateRange, toBusinessDate } from '@/lib/date';
import { getBudgetRange, getEffectiveBudget } from '@/lib/queries/budget';
import { isoWeekStart } from '@/lib/queries/weekly';
import {
  appendTaskFromCandidateInTransaction,
  appendTaskBatchInTransaction,
  validateBatchBudget,
} from '@/lib/services/planWrite';
import {
  applyCarryoverInTransaction,
  CarryoverConflictError,
} from '@/lib/services/carryoverApply';
import type { CarryoverPreview, CarryoverResult } from '@/lib/domain/carryover';
import {
  buildPlan,
  layerOf,
  previewTokenOf,
  type BuildPlanInput,
  type PlanLayer,
} from '@/lib/services/planBuild';
import { buildPlanningSnapshot } from '@/lib/services/planningSnapshot';
import { loadPlanInventory } from '@/lib/services/planInventory';
import { nextPlanVersion } from '@/lib/queries/planning';
import { persistReadinessReview } from '@/lib/services/readiness';
import { applyStageTransition } from '@/lib/services/stageTransition';
import { fail, failValidation, ok } from '@/lib/result';
import type { ActionResult, TaskPriority } from '@/lib/types';
import { isReadyOutcome, type ReadinessOutcome } from '@/lib/domain/readiness';
import {
  candidatePromoteSchema,
  cycleRecalibrateSchema,
  planConfirmSchema,
  planDraftSchema,
  planPreviewSchema,
  readinessReviewSchema,
  replanConfirmSchema,
  replanPreviewSchema,
  stageTransitionSchema,
  versionRestoreSchema,
  weeklySuggestionSchema,
} from '@/lib/schema/planner';
import { confirmReplan, previewReplan, type ReplanPreviewResult } from '@/lib/services/replanPreview';
import { diagnosticProposalFingerprint } from '@/lib/diagnostic/planProposal';

/** 预览返回值：`BuildPlanResult` + 无状态预览令牌。 */
export type BuildPlanPreviewResult = Awaited<ReturnType<typeof buildPlan>> extends ActionResult<infer R>
  ? R & { previewToken: string }
  : never;

/**
 * 生成计划预览：零写 `PlanTask`/`PlanVersion`，返回带 `previewToken` 的草稿。
 *
 * @param raw 客户端表单原始值
 */
export async function generatePlanPreviewAction(
  raw: unknown,
): Promise<ActionResult<BuildPlanPreviewResult>> {
  const parsed = planPreviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const timeZone = await getBusinessTimezone();
  const built = await buildPlan({ ...parsed.data, timeZone, persistSnapshot: false } as BuildPlanInput);
  if (!built.ok) return fail(built.code, built.error);

  return ok({
    ...built.data,
    previewToken: previewTokenOf(
      built.data.snapshotId,
      built.data.inputHash,
      parsed.data.budgetOverrideMinutes,
      built.data.carryover?.fingerprint,
      built.data.inventoryFingerprint,
      built.data.draftFingerprint,
      built.data.proposal?.fingerprint,
    ),
  });
}

/** 确认时解析阶段（与 `buildPlanningSnapshot` 同一套取法，供 `appendTaskFromCandidate` 用）。 */
async function resolveStage(stageId?: string) {
  return stageId
    ? prisma.stage.findUnique({ where: { id: stageId } })
    : prisma.stage.findFirst({ where: { status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' } });
}

/** 找 MONTH 层的父版本（CYCLE）；找不到返回 null。 */
async function resolveParentVersionId(layer: PlanLayer, _asOfDate: string): Promise<string | null> {
  if (layer !== 'MONTH') return null;
  const cycle = await prisma.planVersion.findFirst({
    where: { layer: 'CYCLE', staleAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return cycle?.id ?? null;
}

class PlanConfirmError extends Error {
  constructor(readonly code: 'PRECONDITION' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'PlanConfirmError';
  }
}

/**
 * 确认计划版本： token 校验 → 同一事务应用 carryover、批量写任务与版本头。
 */
export async function confirmPlanVersionAction(
  raw: unknown,
): Promise<ActionResult<{
  version: number;
  versionId: string;
  warnings: string[];
  writtenTaskCount: number;
  carryover: CarryoverPreview | null;
}>> {
  const parsed = planConfirmSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const { snapshotId: previewSnapshotId, previewToken, ...buildInput } = parsed.data;

  const timeZone = await getBusinessTimezone();
  if (buildInput.proposalId) {
    const proposal = await prisma.planProposal.findUnique({
      where: { id: buildInput.proposalId },
      select: { status: true, report: { select: { status: true, createdAt: true } } },
    });
    if (!proposal || proposal.status !== 'DRAFT') {
      return fail('CONFLICT', '诊断草案在预览后已变化或已启用，请返回报告重新预览');
    }
    if (proposal.report.status === 'SUPERSEDED') {
      return fail('CONFLICT', '诊断报告在预览后已被取代，请返回报告重新预览');
    }
    if (toBusinessDate(proposal.report.createdAt, timeZone) !== buildInput.asOfDate) {
      return fail('CONFLICT', '诊断草案在预览后已过期，请返回报告重新预览');
    }
  }
  const built = await buildPlan({ ...buildInput, timeZone, persistSnapshot: false } as BuildPlanInput);
  if (!built.ok) return fail(built.code, built.error);
  if (previewTokenOf(
    built.data.snapshotId,
    built.data.inputHash,
    buildInput.budgetOverrideMinutes,
    built.data.carryover?.fingerprint,
    built.data.inventoryFingerprint,
    built.data.draftFingerprint,
    built.data.proposal?.fingerprint,
  ) !== previewToken || built.data.snapshotId !== previewSnapshotId) {
    return fail('CONFLICT', '计划或上期任务在预览后已变化，请刷新预览再确认');
  }

  if (built.data.proposal && (
    built.data.proposal.scheduledTaskCount !== built.data.proposal.taskCount
    || built.data.proposal.scheduledMinutes !== built.data.proposal.totalMinutes
  )) {
    const remaining = built.data.proposal.totalMinutes - built.data.proposal.scheduledMinutes;
    return fail(
      'PRECONDITION',
      `诊断草案还有 ${remaining} 分钟未排入（已排入 ${built.data.proposal.scheduledTaskCount}/${built.data.proposal.taskCount} 项）；请调整预算或日期后重新预览，未完整排入时不能激活草案`,
    );
  }

  const already = await prisma.planVersion.findUnique({
    where: { idempotencyKey: previewToken },
    select: { id: true },
  });
  if (already) return fail('CONFLICT', '该预览已确认过，请刷新预览再确认');

  let persisted;
  try {
    persisted = await buildPlanningSnapshot({
      purpose: buildInput.purpose,
      asOfDate: buildInput.asOfDate,
      timeZone,
      horizonDays: buildInput.horizonDays,
      stageId: buildInput.stageId,
      planDate: buildInput.planDate,
      proposalId: buildInput.proposalId,
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'P2002') {
      console.error('计划确认唯一约束冲突', { code: 'P2002' });
      return fail('CONFLICT', '计划确认发生并发冲突，请刷新预览后重试');
    }
    throw error;
  }
  if (!persisted.ok) return fail(persisted.code, persisted.error);
  if (persisted.data.inputHash !== built.data.inputHash) {
    return fail('CONFLICT', '计划输入在确认时已变化，请刷新预览再确认');
  }
  const snapshotId = persisted.data.snapshotId;

  const stage = await resolveStage(buildInput.stageId);
  if (!stage) return fail('PRECONDITION', '请先激活一个学习阶段再确认计划');

  const layer = layerOf(buildInput.horizonDays);
  const parentVersionId = await resolveParentVersionId(layer, buildInput.asOfDate);
  const warnings: string[] = [];
  if (layer === 'MONTH' && !parentVersionId) {
    warnings.push('无 30/90 天周期计划，本月计划未挂接上层（仅按时间与证据生成）');
  }

  // 解析候选 id 与决策快照（只对 candidateKey 非空的任务）
  const drafts = built.data.days.flatMap((day) => day.tasks);
  const candidateKeys = [...new Set(drafts.map((t) => t.candidateKey).filter((k): k is string => Boolean(k)))];
  const candidateRows = await prisma.taskCandidate.findMany({
    where: { snapshotId, candidateKey: { in: candidateKeys } },
    select: { id: true, candidateKey: true },
  });
  const candidateIdByKey = new Map(candidateRows.map((row) => [row.candidateKey, row.id] as const));
  const decisionRows = await prisma.taskPriorityDecision.findMany({
    where: { candidateId: { in: [...candidateIdByKey.values()] } },
    select: { candidateId: true, factorsJson: true, score: true, priority: true, rationale: true, weightsVersion: true },
  });
  const decisionByCandidateId = new Map(
    decisionRows.map((row) => [row.candidateId, row] as const),
  );

  const writeInputs: Parameters<typeof appendTaskFromCandidateInTransaction>[1][] = drafts.map((task) => {
    const candidateId = task.candidateKey ? (candidateIdByKey.get(task.candidateKey) ?? null) : null;
    let factors: unknown = null;
    let score: number | null = null;
    let weightsVersion: string | null = null;
    if (candidateId) {
      const decision = decisionByCandidateId.get(candidateId);
      if (decision) {
        try {
          factors = JSON.parse(decision.factorsJson);
        } catch {
          factors = null;
        }
        score = decision.score;
        weightsVersion = decision.weightsVersion;
      }
    }
    const decisionJson = JSON.stringify({
      candidateKey: task.candidateKey,
      factors,
      score,
      weightsVersion,
      rationale: task.explanation.reason,
      ...task.explanation,
      estimate: task.explanation.estimate,
      expectedOutput: task.explanation.expectedOutput,
      candidateMeta: task.explanation.candidateMeta,
    });
    return {
      stageId: stage.id,
      planDate: task.planDate,
      module: task.module,
      skill: task.skill,
      plannedMinutes: task.plannedMinutes,
      priority: task.priority,
      sourceKind: task.sourceKind,
      track: task.track,
      primarySkill: task.primarySkill,
      minChunkMinutes: task.minChunkMinutes,
      splittable: task.splittable,
      note: task.explanation.origin === 'USER_EDIT'
        ? `${task.title}；${task.explanation.reason}`
        : task.explanation.reason,
      candidateId,
      decisionJson,
      origin: 'CANDIDATE_CONFIRM',
      budgetPrevalidated: true,
      idempotencyKey: previewToken,
    };
  });

  const headerPlanDate = buildInput.planDate ?? buildInput.asOfDate;
  const inventoryEndDate = addDays(buildInput.asOfDate, buildInput.horizonDays - 1);

  const carryoverDecisions: CarryoverResult['decisions'] = built.data.carryover?.decisions.map((decision) => {
    if (decision.action === 'PROMOTE') {
      return { taskId: decision.taskId, overdueDays: decision.overdueDays, verdict: { action: 'PROMOTE', toPriority: decision.finalPriority!, reason: decision.reason } };
    }
    if (decision.action === 'DEMOTE') {
      return { taskId: decision.taskId, overdueDays: decision.overdueDays, verdict: { action: 'DEMOTE', toPriority: decision.finalPriority!, reason: decision.reason } };
    }
    if (decision.action === 'BACKLOG') {
      return { taskId: decision.taskId, overdueDays: decision.overdueDays, verdict: { action: 'BACKLOG', reason: decision.reason } };
    }
    return { taskId: decision.taskId, overdueDays: decision.overdueDays, verdict: { action: 'ABANDON', reason: decision.reason } };
  }) ?? [];

  try {
    const committed = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.planVersion.findUnique({
        where: { idempotencyKey: previewToken },
        select: { id: true },
      });
      if (duplicate) throw new PlanConfirmError('CONFLICT', '该预览已确认过，请刷新预览再确认');

      if (built.data.proposal) {
        const proposal = await tx.planProposal.findUnique({
          where: { id: built.data.proposal.id },
          select: {
            status: true,
            tasksJson: true,
            report: { select: { status: true, createdAt: true } },
          },
        });
        const fingerprint = proposal
          ? diagnosticProposalFingerprint({
              id: built.data.proposal.id,
              status: proposal.status,
              asOfDate: buildInput.asOfDate,
              tasksJson: proposal.tasksJson,
            })
          : null;
        if (!proposal || proposal.status !== 'DRAFT' || fingerprint !== built.data.proposal.fingerprint) {
          throw new PlanConfirmError('CONFLICT', '诊断草案在预览后已变化或已启用，请返回报告重新预览');
        }
        if (proposal.report.status === 'SUPERSEDED') {
          throw new PlanConfirmError('CONFLICT', '诊断报告在预览后已被取代，请返回报告重新预览');
        }
        if (toBusinessDate(proposal.report.createdAt, timeZone) !== buildInput.asOfDate) {
          throw new PlanConfirmError('CONFLICT', '诊断草案在预览后已过期，请返回报告重新预览');
        }
      }

      const inventory = await loadPlanInventory(
        buildInput.asOfDate,
        inventoryEndDate,
        tx,
      );
      if (inventory.fingerprint !== built.data.inventoryFingerprint) {
        throw new PlanConfirmError('CONFLICT', '当日已有任务在预览后已变化，请刷新预览再确认');
      }

      if (built.data.carryover && built.data.carryover.decisions.length > 0) {
        await applyCarryoverInTransaction(tx, {
          targetDate: built.data.carryover.asOfDate,
          decisions: carryoverDecisions,
          expectedFingerprint: built.data.carryover.fingerprint,
        });
      }

      const dates = [...new Set([headerPlanDate, ...writeInputs.map((task) => task.planDate)])];
      const committedInventory = await loadPlanInventory(
        buildInput.asOfDate,
        inventoryEndDate,
        tx,
      );
      const budgetDays = [];
      for (const date of dates) {
        const effective = await getEffectiveBudget(date, tx);
        const minutes = date === buildInput.asOfDate && buildInput.budgetOverrideMinutes !== undefined
          ? buildInput.budgetOverrideMinutes
          : effective.minutes;
        const isRestDay = date === buildInput.asOfDate && buildInput.budgetOverrideMinutes !== undefined
          ? buildInput.budgetOverrideMinutes === 0
          : effective.isRestDay;
        const added = writeInputs
          .filter((task) => task.planDate === date)
          .reduce((sum, task) => sum + task.plannedMinutes, 0);
        budgetDays.push({ date, minutes, isRestDay });
        const check = validateBatchBudget(
          [{ date, minutes: (committedInventory.reservedMinutesByDate.get(date) ?? 0) + added }],
          [{ date, minutes, isRestDay }],
        );
        if (!check.ok) throw new PlanConfirmError('PRECONDITION', check.error);
      }

      const appended = await appendTaskBatchInTransaction(tx, writeInputs, {
        primaryPlanDate: headerPlanDate,
        budgetPrevalidated: true,
      });
      const writtenTaskIds = appended.taskIds;
      let versionHeaders = appended.versions;
      if (!versionHeaders.some((header) => header.planDate === headerPlanDate)) {
        const headerDate = budgetDays.find((day) => day.date === headerPlanDate);
        const net = await tx.studySessionDaySplit.aggregate({
          where: { date: headerPlanDate },
          _sum: { minutes: true },
        });
        const created = await tx.planVersion.create({
          data: {
            planDate: headerPlanDate,
            version: await nextPlanVersion(headerPlanDate, tx),
            changeSource: 'GENERATE',
            reason: '候选任务确认写入计划',
            budgetMinutes: headerDate?.minutes ?? 0,
            actualMinutesAtChange: net._sum.minutes ?? 0,
            beforeSnapshot: JSON.stringify({ carryover: built.data.carryover }),
            afterSnapshot: '{}',
            idempotencyKey: previewToken,
            snapshotId,
            layer: layer === 'DAY' ? 'DAY' : layer,
            parentVersionId,
          },
          select: { id: true, planDate: true, version: true },
        });
        versionHeaders = [created];
      }

      const finalInventory = await loadPlanInventory(
        buildInput.asOfDate,
        inventoryEndDate,
        tx,
      );
      for (const day of budgetDays) {
        const check = validateBatchBudget(
          [{ date: day.date, minutes: finalInventory.reservedMinutesByDate.get(day.date) ?? 0 }],
          [day],
        );
        if (!check.ok) throw new PlanConfirmError('PRECONDITION', check.error);
      }

      for (const header of versionHeaders) {
        const active = await tx.planTask.findMany({
          where: { planDate: header.planDate, status: { notIn: ['CANCELLED', 'DEFERRED'] } },
          select: { id: true, plannedMinutes: true },
          orderBy: { sortOrder: 'asc' },
        });
        const isPrimary = header.planDate === headerPlanDate;
        const afterSnapshot = isPrimary && (layer === 'MONTH' || layer === 'CYCLE')
          ? built.data.layerStructure ?? {}
          : {
              taskCount: active.length,
              newTaskCount: active.filter((task) => writtenTaskIds.includes(task.id)).length,
              totalMinutes: finalInventory.reservedMinutesByDate.get(header.planDate) ?? 0,
              taskIds: active.map((task) => task.id),
              carryover: isPrimary ? built.data.carryover : null,
              layer: layer === 'DAY' ? 'DAY' : layer,
            };
        await tx.planVersion.update({
          where: { id: header.id },
          data: {
            budgetMinutes: budgetDays.find((day) => day.date === header.planDate)?.minutes ?? 0,
            afterSnapshot: JSON.stringify(afterSnapshot),
            snapshotId,
            layer: layer === 'DAY' ? 'DAY' : layer,
            parentVersionId,
          },
        });
      }
      if (built.data.proposal) {
        const activated = await tx.planProposal.updateMany({
          where: { id: built.data.proposal.id, status: 'DRAFT' },
          data: { status: 'ACTIVE', activatedAt: new Date() },
        });
        if (activated.count !== 1) {
          throw new PlanConfirmError('CONFLICT', '诊断草案已被处理，本次计划写入已回滚');
        }
      }
      const primaryHeader = versionHeaders.find((header) => header.planDate === headerPlanDate)!;
      return { version: primaryHeader.version, versionId: primaryHeader.id };
    });

    try {
      revalidatePath('/');
      revalidatePath('/plan');
      revalidatePath('/planner');
    } catch (error) {
      console.error('计划已提交，但页面缓存刷新失败', {
        name: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return ok({
      ...committed,
      warnings,
      writtenTaskCount: writeInputs.length,
      carryover: built.data.carryover,
    });
  } catch (error) {
    if (error instanceof CarryoverConflictError) {
      return fail('CONFLICT', error.message);
    }
    if (error instanceof PlanConfirmError) {
      return fail(error.code, error.message);
    }
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'P2002') {
      console.error('计划确认唯一约束冲突', { code: 'P2002' });
      return fail('CONFLICT', '计划确认发生并发冲突，请刷新预览后重试');
    }
    console.error('计划确认失败', {
      name: error instanceof Error ? error.name : 'UnknownError',
    });
    return fail('INTERNAL', '计划确认失败，本次变更已回滚，请稍后重试');
  }
}

/**
 * 保存草稿：T07 复用 `PlanningSnapshot` 作为草稿锚点（没有单独 PlanDraft 表）。
 * 预览/草稿都**不写** `PlanTask`/`PlanVersion`。
 */
export async function saveDraftAction(raw: unknown): Promise<ActionResult<{ draftId: string }>> {
  const parsed = planDraftSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const snapshot = await buildPlanningSnapshot({
    purpose: parsed.data.purpose,
    asOfDate: parsed.data.asOfDate,
    timeZone: await getBusinessTimezone(),
    horizonDays: parsed.data.horizonDays,
    stageId: parsed.data.stageId,
    planDate: parsed.data.planDate,
    proposalId: parsed.data.proposalId,
  });
  if (!snapshot.ok) return fail(snapshot.code, snapshot.error);

  revalidatePath('/planner');
  return ok({ draftId: snapshot.data.snapshotId });
}

/**
 * 提升候选优先级：只改 `TaskPriorityDecision.priority`，**不写** `PlanTask`。
 * 调度重算以这条决策为准（`41 §2.10`）。
 */
export async function promoteCandidateAction(
  raw: unknown,
): Promise<ActionResult<{ candidateId: string; priority: TaskPriority }>> {
  const parsed = candidatePromoteSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const decision = await prisma.taskPriorityDecision.findUnique({
    where: { candidateId: parsed.data.candidateId },
    select: { id: true },
  });
  if (!decision) return fail('NOT_FOUND', '候选决策不存在或已被清理');

  await prisma.taskPriorityDecision.update({
    where: { candidateId: parsed.data.candidateId },
    data: { priority: parsed.data.priority },
  });

  revalidatePath('/planner');
  return ok({ candidateId: parsed.data.candidateId, priority: parsed.data.priority });
}

/**
 * 恢复历史版本：生成**新**版本（append-only，不改历史行）。
 * 只允许 `DAY`（layer=null）与 `WEEK`（`41 §5.5`）；MONTH/CYCLE 本期不支持。
 */
export async function restorePlanVersionAction(
  raw: unknown,
): Promise<ActionResult<{ version: number }>> {
  const parsed = versionRestoreSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const source = await prisma.planVersion.findUnique({ where: { id: parsed.data.versionId } });
  if (!source) return fail('NOT_FOUND', '版本不存在或已被清理');

  const layer = source.layer ?? 'DAY';
  if (layer !== 'DAY' && layer !== 'WEEK') {
    return fail('PRECONDITION', 'MONTH/CYCLE 层版本本期不支持恢复');
  }

  const version = await nextPlanVersion(source.planDate);
  await prisma.planVersion.create({
    data: {
      planDate: source.planDate,
      version,
      changeSource: 'REPLAN',
      reason: `从版本 ${source.version} 恢复`,
      budgetMinutes: source.budgetMinutes,
      actualMinutesAtChange: source.actualMinutesAtChange,
      beforeSnapshot: source.afterSnapshot,
      afterSnapshot: source.afterSnapshot,
      snapshotId: source.snapshotId,
      layer: source.layer,
      parentVersionId: source.parentVersionId,
    },
  });

  revalidatePath('/planner');
  return ok({ version });
}

/**
 * 重排预览（T08）：零写库，直接调用 `previewReplan()`（内部复用 `replanDailyTasks`）。
 * 返回 diff + 无状态 `previewToken`，确认时校验「预览 == 实际」。
 */
export async function previewReplanAction(
  raw: unknown,
): Promise<ActionResult<ReplanPreviewResult>> {
  const parsed = replanPreviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  return previewReplan(parsed.data);
}

/**
 * 确认重排（T08）：token 校验 → 空版本/幂等拦截 → 一次事务落库。
 * 成功后写 1 条 `PlanVersion(changeSource='REPLAN', idempotencyKey)`。
 */
export async function confirmReplanAction(
  raw: unknown,
): Promise<Awaited<ReturnType<typeof confirmReplan>>> {
  const parsed = replanConfirmSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await confirmReplan(parsed.data);
  if (result.ok) {
    revalidatePath('/');
    revalidatePath('/plan');
    revalidatePath('/planner');
  }
  return result;
}

/**
 * 生成阶段 readiness 评审（T09）：装配五维证据 → `computeReadiness()` → 落库
 * `StageReadinessReview`（`criteriaJson` 必存五维明细）。**只建议，不切阶段**。
 */
export async function reviewReadinessAction(
  raw: unknown,
): Promise<ActionResult<{ reviewId: string; outcome: ReadinessOutcome }>> {
  const parsed = readinessReviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await persistReadinessReview({
    ...parsed.data,
    timeZone: await getBusinessTimezone(),
  });
  if (!result.ok) return fail(result.code, result.error);

  revalidatePath('/planner');
  revalidatePath('/planner/readiness');
  return ok({ reviewId: result.data.reviewId, outcome: result.data.outcome });
}

/**
 * 用户确认进入下一阶段（T09）：同一事务里 ① 把 `StageReadinessReview` 标成
 * `USER_APPROVED_TRANSITION` + `userConfirmed`；② 调共享核心 `applyStageTransition`
 * 真正翻转 `Stage.status` 并写 append-only `StageTransitionLog`。
 *
 * 幂等仍由 `review.userConfirmed` 挡：重复确认 → `CONFLICT`，不会二次翻转阶段。
 * guard：目标阶段已是当前 ACTIVE → `PRECONDITION`（对齐 `transitionStageAction`）。
 */
export async function confirmStageTransitionAction(
  raw: unknown,
): Promise<ActionResult<{ reviewId: string; logId: string }>> {
  const parsed = stageTransitionSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const review = await prisma.stageReadinessReview.findUnique({
    where: { id: parsed.data.reviewId },
  });
  if (!review) return fail('NOT_FOUND', 'readiness 评审不存在或已被清理');
  if (review.userConfirmed) return fail('CONFLICT', '该评审已确认过切换');
  if (!isReadyOutcome(review.outcome)) {
    return fail('PRECONDITION', '当前评审未达到可确认状态，不能确认切换');
  }

  let criteria: unknown;
  try {
    criteria = JSON.parse(review.criteriaJson) as unknown;
  } catch {
    return fail('PRECONDITION', '评审证据快照损坏，不能确认切换');
  }
  const dimensions = Array.isArray(criteria)
    ? criteria
    : criteria && typeof criteria === 'object' && 'dimensions' in criteria
      ? (criteria as { dimensions?: unknown }).dimensions
      : null;
  const expectedCodes = [
    'D1_EVIDENCE_COVERAGE', 'D2_CROSS_SOURCE_CONSISTENCY', 'D3_INDEPENDENT_COMPLETION',
    'D4_DELAYED_RETENTION', 'D5_TRANSFER_EVIDENCE',
  ];
  if (!Array.isArray(dimensions) || dimensions.length !== expectedCodes.length) {
    return fail('PRECONDITION', '评审五维证据快照不完整，不能确认切换');
  }
  const validDimensions = expectedCodes.every((code) => dimensions.some(
    (row) => row && typeof row === 'object' && 'code' in row && 'status' in row
      && row.code === code && row.status === 'PASS',
  ));
  if (!validDimensions) {
    return fail('PRECONDITION', '五维证据未全部 PASS 或存在 READ_ERROR，不能确认切换');
  }

  const target = await prisma.stage.findUnique({ where: { code: parsed.data.toStageCode } });
  if (!target) return fail('NOT_FOUND', '目标阶段不存在');

  const current = await prisma.stage.findFirst({ where: { status: 'ACTIVE' } });
  if (!current || current.id !== review.stageId) {
    return fail('PRECONDITION', '评审不属于当前进行中的阶段，请刷新评审');
  }
  if (current.id === target.id) {
    return fail('PRECONDITION', '目标阶段已经是当前进行中的阶段');
  }

  const timeZone = await getBusinessTimezone();
  const log = await prisma.$transaction(async (tx) => {
    await tx.stageReadinessReview.update({
      where: { id: review.id },
      data: {
        outcome: 'USER_APPROVED_TRANSITION',
        userConfirmed: true,
        confirmedAt: new Date(),
        confirmedBy: parsed.data.confirmedBy.trim(),
        note: parsed.data.note?.trim() || null,
      },
    });
    return applyStageTransition(tx, {
      fromStageCode: current?.code ?? null,
      toStageCode: target.code,
      reason: parsed.data.reason.trim(),
      // criteriaJson 就是「当时凭什么说 Ready」的逐维证据快照
      evidenceSnapshot: review.criteriaJson,
    }, timeZone);
  });

  revalidatePath('/');
  revalidatePath('/stages');
  revalidatePath('/planner');
  revalidatePath('/planner/readiness');
  return ok({ reviewId: review.id, logId: log.id });
}

/**
 * 90 天周期中途重新校准（AC-13）：**只产生新的周期版本，不改历史**。
 *
 * - 不修改任何既有 `PlanVersion`（含旧 CYCLE 版本）：历史是 append-only；
 * - 不改写既有 `PlanTask`：校准只更新「这 90 天练什么」的结构展望；
 * - 同一份证据（同一 snapshotId）已经产出过有效 CYCLE 版本 → `CONFLICT`，
 *   避免重复点击把同一主题写成一串版本。
 */
export async function recalibrateCycleAction(
  raw: unknown,
): Promise<ActionResult<{ cycleId: string; version: number; versionId: string }>> {
  const parsed = cycleRecalibrateSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const cycle = await prisma.learningCycle.findFirst({
    where: { archivedAt: null, status: { not: 'COMPLETED' } },
    orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
  });
  if (!cycle) return fail('PRECONDITION', '没有进行中的 90 天周期，无法重新校准');

  if (parsed.data.cycleVersionId) {
    const previous = await prisma.planVersion.findUnique({
      where: { id: parsed.data.cycleVersionId },
      select: { layer: true },
    });
    if (!previous) return fail('NOT_FOUND', '要校准的周期版本不存在');
    if (previous.layer !== 'CYCLE') {
      return fail('VALIDATION', '只有 90 天周期版本可以重新校准');
    }
  }

  const built = await buildPlan({
    purpose: 'GENERATE',
    asOfDate: parsed.data.asOfDate,
    timeZone: await getBusinessTimezone(),
    horizonDays: 90,
    allowAi: false,
  });
  if (!built.ok) return fail(built.code, built.error);

  const sameSnapshot = await prisma.planVersion.findFirst({
    where: { layer: 'CYCLE', snapshotId: built.data.snapshotId, staleAt: null },
    select: { id: true },
  });
  if (sameSnapshot) {
    return fail('CONFLICT', '本次证据与上一周期版本一致，无需重新校准');
  }

  const version = await nextPlanVersion(parsed.data.asOfDate);
  const created = await prisma.planVersion.create({
    data: {
      planDate: parsed.data.asOfDate,
      version,
      changeSource: 'GENERATE',
      reason: `周期重新校准：${parsed.data.reason.trim()}`,
      budgetMinutes: 0,
      actualMinutesAtChange: 0,
      beforeSnapshot: JSON.stringify({
        cycleId: cycle.id,
        previousVersionId: parsed.data.cycleVersionId ?? null,
        primaryTheme: cycle.primaryTheme,
        secondaryThemesJson: cycle.secondaryThemesJson,
      }),
      afterSnapshot: JSON.stringify(built.data.layerStructure ?? {}),
      snapshotId: built.data.snapshotId,
      layer: 'CYCLE',
      parentVersionId: null,
    },
    select: { id: true },
  });

  revalidatePath('/planner');
  revalidatePath('/planner/build');
  revalidatePath('/planner/history');
  return ok({ cycleId: cycle.id, version, versionId: created.id });
}

// ───────────────────────── T13 周复盘：采纳周度建议 ─────────────────────────

const WEEKLY_SUGGESTION_KIND_LABEL: Record<'ADJUST_TIME' | 'ADJUST_FOCUS' | 'KEEP', string> = {
  ADJUST_TIME: '调整时间',
  ADJUST_FOCUS: '调整重点',
  KEEP: '保持不变',
};

/**
 * 采纳一条周度建议 → 写入**下一周**的 `WeeklyTarget`（`source=SUGGESTION_ACCEPTED`）。
 *
 * 三条边界：
 * 1. 只写下一周，不改本周已发生的预算与计划（append-only 语义）；
 * 2. 建议本身不自动生效 —— 这个 action 只有用户显式点击才会被调用；
 * 3. 未给 `targetMinutes` 时按下一周已生效的日预算求和兜底，绝不凭空造数字。
 */
export async function acceptWeeklySuggestionAction(
  raw: unknown,
): Promise<ActionResult<{ weeklyTargetId: string; weekStart: string; targetMinutes: number }>> {
  const parsed = weeklySuggestionSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const { isoYear, isoWeek, suggestion } = parsed.data;

  const nextWeekStart = addDays(isoWeekStart(isoYear, isoWeek), 7);
  const nextWeekEnd = addDays(nextWeekStart, 6);

  let targetMinutes = suggestion.targetMinutes ?? null;
  if (targetMinutes === null) {
    const budgets = await getBudgetRange(listDateRange(nextWeekStart, nextWeekEnd));
    const sum = [...budgets.values()]
      .filter((budget) => !budget.isRestDay)
      .reduce((total, budget) => total + budget.minutes, 0);
    targetMinutes = sum > 0 ? sum : null;
  }
  if (targetMinutes === null || targetMinutes <= 0) {
    return fail('VALIDATION', '下一周没有可用预算，请先设置日预算或直接填写周目标分钟');
  }

  const note = `[${WEEKLY_SUGGESTION_KIND_LABEL[suggestion.kind]}] ${suggestion.note}`;
  const existing = await prisma.weeklyTarget.findUnique({ where: { weekStart: nextWeekStart } });
  const row = existing
    ? await prisma.weeklyTarget.update({
        where: { id: existing.id },
        data: { targetMinutes, source: 'SUGGESTION_ACCEPTED', status: 'ADJUSTED', note },
        select: { id: true },
      })
    : await prisma.weeklyTarget.create({
        data: { weekStart: nextWeekStart, targetMinutes, source: 'SUGGESTION_ACCEPTED', note },
        select: { id: true },
      });

  revalidatePath('/weekly');
  revalidatePath('/plan');
  revalidatePath('/planner/budget');
  return ok({ weeklyTargetId: row.id, weekStart: nextWeekStart, targetMinutes });
}
