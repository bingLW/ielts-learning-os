/**
 * 阶段 readiness 的数据装配与落库（T09）。
 *
 * 职责（顺序固定）：
 * 1. 复用 `buildPlanningSnapshot({ purpose: 'READINESS' })` 拿到最新的 OFFICIAL 缺口 /
 *    不确定（同一套装配，避免另写一套"简化版"缺口判断 —— 那会与评分层/候选层口径漂移）；
 * 2. 聚合 `EvidenceRecord` → `evidenceBySkill` + `distinctSources`；
 * 3. 聚合 `RetestSchedule` → `retestOutcomes`；
 * 4. `computeReadiness()` 纯函数判结论；
 * 5. `StageReadinessReview` 落库，**`criteriaJson` 必存五维明细**（否则 History 页无法
 *    回溯「当时凭什么说 Ready」）。
 *
 * 已知限制（`docs/47-v2.7-known-limits.md`）：当前 `buildPlanningSnapshot` 装配缺口时
 * `coverageRatio` 恒为 `null`（真实值需要分题型正确率，证据行尚无该维度）。因此本服务
 * 产出的 D1 覆盖率会偏保守（按「覆盖未知 → 未达标」处理）。这只影响服务层的真实结论，
 * 不影响 `computeReadiness` 纯函数的正确性 —— 单测用手抄输入覆盖了 D1 全 PASS 分支。
 */

import { prisma } from '@/lib/prisma';
import {
  computeReadiness,
  type EvidenceDistribution,
  type ReadinessDimensionCode,
  type ReadinessResult,
  type RetestOutcome,
} from '@/lib/domain/readiness';
import { buildPlanningSnapshot } from '@/lib/services/planningSnapshot';
import { fail, ok } from '@/lib/result';
import type { ActionResult } from '@/lib/types';

/** 官方四项（与画像四技能同源）。 */
const OFFICIAL_SKILLS = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as const;

export interface PersistReadinessReviewInput {
  stageId: string;
  asOfDate: string;
}

export interface PersistReadinessReviewResult {
  reviewId: string;
  outcome: ReadinessResult['outcome'];
  result: ReadinessResult;
}

function emptyEvidence(): EvidenceDistribution {
  return { baseline: 0, immediate: 0, delayed: 0, applied: 0, transfer: 0, independent: 0 };
}

/**
 * 装配并落库一次 readiness 评审（append-only：每次调用新增一行）。
 *
 * @param input 阶段与基准日
 */
export async function persistReadinessReview(
  input: PersistReadinessReviewInput,
): Promise<ActionResult<PersistReadinessReviewResult>> {
  const stage = await prisma.stage.findUnique({ where: { id: input.stageId } });
  if (!stage) return fail('NOT_FOUND', '阶段不存在');

  const snapshot = await buildPlanningSnapshot({
    purpose: 'READINESS',
    asOfDate: input.asOfDate,
    horizonDays: 1,
    stageId: input.stageId,
  });
  if (!snapshot.ok) return fail(snapshot.code, snapshot.error);

  // 缺口/不确定直接复用快照装配（已是 OFFICIAL 维度）；UNKNOWN 与 UNCERTAINTY 在
  // readiness 里同属「证据不足」，合并进 officialUncertainties。
  const officialGaps = snapshot.data.context.gaps;
  const officialUncertainties = [
    ...snapshot.data.context.uncertainties,
    ...snapshot.data.context.unknowns,
  ];

  const readErrors: ReadinessDimensionCode[] = [];
  let evidenceBySkill: Record<string, EvidenceDistribution> = {};
  let distinctSources: { skill: string; sourceRefs: string[] }[] = [];

  // ── 证据分布 + 多来源（同一批 EvidenceRecord 一次查出）──
  try {
    const evidenceRows = await prisma.evidenceRecord.findMany({
      where: { skill: { in: [...OFFICIAL_SKILLS] }, archivedAt: null },
      select: { skill: true, evidenceType: true, assistanceLevel: true, taskId: true, sessionId: true },
    });

    const bySkill = new Map<string, EvidenceDistribution>(
      OFFICIAL_SKILLS.map((skill) => [skill, emptyEvidence()]),
    );
    const sourceSets = new Map<string, Set<string>>(
      OFFICIAL_SKILLS.map((skill) => [skill, new Set<string>()]),
    );

    for (const row of evidenceRows) {
      const skill = row.skill;
      if (!bySkill.has(skill)) bySkill.set(skill, emptyEvidence());
      const dist = bySkill.get(skill) ?? emptyEvidence();
      if (row.evidenceType === 'BASELINE') dist.baseline += 1;
      else if (row.evidenceType === 'IMMEDIATE_RETEST') dist.immediate += 1;
      else if (row.evidenceType === 'DELAYED_RETEST') dist.delayed += 1;
      else if (row.evidenceType === 'APPLIED_TASK') dist.applied += 1;
      else if (row.evidenceType === 'TRANSFER') dist.transfer += 1;
      if (row.assistanceLevel === 'A0') dist.independent += 1;
      bySkill.set(skill, dist);

      // 「来源」= 任务/会话（材料通过任务再关联，这里不二次 JOIN，保持查询为一次读取）。
      if (!sourceSets.has(skill)) sourceSets.set(skill, new Set<string>());
      const ref = row.taskId ? `task:${row.taskId}` : row.sessionId ? `session:${row.sessionId}` : null;
      if (ref) sourceSets.get(skill)?.add(ref);
    }

    evidenceBySkill = Object.fromEntries(bySkill.entries());
    distinctSources = [...sourceSets.entries()].map(([skill, sourceRefs]) => ({
      skill,
      sourceRefs: [...sourceRefs],
    }));
  } catch {
    // 证据读失败 → 证据覆盖 / 多来源 / 无辅助三维都失去输入。
    readErrors.push('D1_EVIDENCE_COVERAGE', 'D2_CROSS_SOURCE_CONSISTENCY', 'D3_INDEPENDENT_COMPLETION');
  }

  // ── 延迟 / 迁移复测 ──
  let retestOutcomes: RetestOutcome[] = [];
  try {
    const retestRows = await prisma.retestSchedule.findMany({
      where: { retestType: { in: ['IMMEDIATE', 'DELAYED', 'APPLIED', 'TRANSFER'] } },
      select: {
        retestType: true,
        status: true,
        parent: { select: { skill: true } },
        completed: { select: { score: true } },
      },
    });
    retestOutcomes = retestRows.map((row) => ({
      retestType: row.retestType as RetestOutcome['retestType'],
      skill: row.parent?.skill ?? '',
      status: row.status as RetestOutcome['status'],
      score: row.completed?.score ?? null,
      // `RetestSchedule` 无 material 列；迁移证据的物源由 completed evidence 的 condition
      // 承载。本字段不进任何判定，仅作展示位，服务层不强行解析 conditionJson。
      materialRef: null,
    }));
  } catch {
    readErrors.push('D4_DELAYED_RETENTION', 'D5_TRANSFER_EVIDENCE');
  }

  const result = computeReadiness({
    stageId: input.stageId,
    stageStart: stage.startedAt ?? null,
    asOfDate: input.asOfDate,
    officialGaps,
    officialUncertainties,
    evidenceBySkill,
    retestOutcomes,
    distinctSources,
    readErrors,
  });

  const review = await prisma.stageReadinessReview.create({
    data: {
      snapshotId: snapshot.data.snapshotId,
      stageId: input.stageId,
      outcome: result.outcome,
      criteriaJson: JSON.stringify(result.dimensions),
      evidenceRefsJson: JSON.stringify(result.dimensions.flatMap((dimension) => dimension.evidenceRefs)),
      unmetJson: JSON.stringify(result.unmet),
      userConfirmed: false,
    },
    select: { id: true },
  });

  return ok({ reviewId: review.id, outcome: result.outcome, result });
}
