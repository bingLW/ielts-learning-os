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
import { prisma } from '@/lib/prisma';
import { appendTaskFromCandidate } from '@/lib/services/planWrite';
import {
  buildPlan,
  layerOf,
  previewTokenOf,
  type BuildPlanInput,
  type PlanLayer,
} from '@/lib/services/planBuild';
import { buildPlanningSnapshot } from '@/lib/services/planningSnapshot';
import { nextPlanVersion } from '@/lib/queries/planning';
import { fail, failValidation, ok } from '@/lib/result';
import type { ActionResult, TaskPriority } from '@/lib/types';
import {
  candidatePromoteSchema,
  planConfirmSchema,
  planDraftSchema,
  planPreviewSchema,
  versionRestoreSchema,
} from '@/lib/schema/planner';

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

  const built = await buildPlan(parsed.data as BuildPlanInput);
  if (!built.ok) return fail(built.code, built.error);

  return ok({
    ...built.data,
    previewToken: previewTokenOf(built.data.snapshotId, built.data.inputHash, parsed.data.budgetOverrideMinutes),
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

/**
 * 确认计划版本：校验 token → 复用同一 `snapshotId` → 逐条 `appendTaskFromCandidate`
 * → 写 1 条带 `snapshotId` 与 `layer` 的 `PlanVersion`。同 token 重复确认 → `CONFLICT`。
 */
export async function confirmPlanVersionAction(
  raw: unknown,
): Promise<ActionResult<{ version: number; versionId: string; warnings: string[] }>> {
  const parsed = planConfirmSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const { snapshotId, previewToken, ...buildInput } = parsed.data;

  const snapshot = await prisma.planningSnapshot.findUnique({
    where: { id: snapshotId },
    select: { inputHash: true },
  });
  if (!snapshot) return fail('NOT_FOUND', '预览快照不存在或已被清理');

  if (previewTokenOf(snapshotId, snapshot.inputHash, buildInput.budgetOverrideMinutes) !== previewToken) {
    return fail('CONFLICT', '计划在预览后已变化，请刷新预览再确认');
  }

  const already = await prisma.planVersion.findUnique({ where: { idempotencyKey: previewToken } });
  if (already) return fail('CONFLICT', '该预览已确认过，请刷新预览再确认');

  const built = await buildPlan(buildInput as BuildPlanInput);
  if (!built.ok) return fail(built.code, built.error);
  if (built.data.snapshotId !== snapshotId) {
    return fail('CONFLICT', '输入与预览不一致，请刷新预览再确认');
  }

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
    select: { candidateId: true, factorsJson: true, score: true, priority: true, rationale: true },
  });
  const decisionByCandidateId = new Map(
    decisionRows.map((row) => [row.candidateId, row] as const),
  );

  // 逐条写入（唯一写入者：每条约自己的事务 + 预算闸门 + 版本审计）
  for (const task of drafts) {
    const candidateId = task.candidateKey ? (candidateIdByKey.get(task.candidateKey) ?? null) : null;
    let decisionJson: string | null = null;
    if (candidateId) {
      const decision = decisionByCandidateId.get(candidateId);
      if (decision) {
        let factors: unknown = null;
        try {
          factors = JSON.parse(decision.factorsJson);
        } catch {
          factors = null;
        }
        decisionJson = JSON.stringify({
          factors,
          score: decision.score,
          priority: decision.priority,
          rationale: decision.rationale,
        });
      }
    }

    const appended = await appendTaskFromCandidate({
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
      note: task.explanation.reason,
      candidateId,
      decisionJson,
      origin: 'CANDIDATE_CONFIRM',
    });
    if (!appended.ok) return fail(appended.code, appended.error, appended.fieldErrors);
  }

  // 写 1 条带 snapshotId + layer 的「头」版本（MONTH 层承载 8 项结构）
  const headerPlanDate = buildInput.planDate ?? buildInput.asOfDate;
  const version = await nextPlanVersion(headerPlanDate);
  const afterSnapshot =
    layer === 'MONTH' || layer === 'CYCLE'
      ? JSON.stringify(built.data.layerStructure ?? {})
      : JSON.stringify({
          taskCount: drafts.length,
          totalMinutes: drafts.reduce((sum, t) => sum + t.plannedMinutes, 0),
          layer,
        });

  const header = await prisma.planVersion.create({
    data: {
      planDate: headerPlanDate,
      version,
      changeSource: 'GENERATE',
      reason: '候选任务确认写入计划',
      budgetMinutes: buildInput.budgetOverrideMinutes ?? 0,
      actualMinutesAtChange: 0,
      beforeSnapshot: JSON.stringify({ taskCount: 0 }),
      afterSnapshot,
      idempotencyKey: previewToken,
      snapshotId,
      layer: layer === 'DAY' ? null : layer,
      parentVersionId,
    },
    select: { id: true },
  });

  revalidatePath('/');
  revalidatePath('/plan');
  revalidatePath('/planner');
  return ok({ version, versionId: header.id, warnings });
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
    horizonDays: parsed.data.horizonDays,
    stageId: parsed.data.stageId,
    planDate: parsed.data.planDate,
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
