/**
 * 材料审核状态的落地（把闸门结论写回 `LearningMaterial`）。
 *
 * 分工：`materialReviewGate` 只算「该是什么状态」，这里只做「读计数 + 写状态」。
 * 状态转移**必须**走 `stateMachine` 的 `canTransition` —— 自己写 if 判断迟早会和
 * 状态机表漂移（T08 的教训：重试续跑就是被一处手写判断坑掉的）。
 */

import { parseJson } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import {
  evaluateMaterialReviewGate,
  type ReviewGateResult,
} from '@/lib/domain/materialReviewGate';
import { canTransition } from '@/lib/materials/stateMachine';
import type { MaterialStatus } from '@/lib/constants';

/** 最新 job 的 `progressJson` 里被丢弃的条数（无 job / 无该字段 → 0）。 */
async function readDroppedUnverifiable(materialId: string): Promise<number> {
  const job = await prisma.processingJob.findFirst({
    where: { materialId },
    orderBy: { startedAt: 'desc' },
    select: { progressJson: true },
  });
  const progress = parseJson<{ droppedUnverifiable?: unknown }>(job?.progressJson, {}) ?? {};
  const value = progress.droppedUnverifiable;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 只读地算出当前闸门结论（页面渲染用它，不改库）。
 *
 * @param materialId 材料 id
 */
export async function readMaterialReviewGate(materialId: string): Promise<ReviewGateResult> {
  const [pendingExtractions, pendingExercises, pendingCandidates, droppedUnverifiable] =
    await Promise.all([
      prisma.extractionResult.count({ where: { materialId, reviewStatus: 'draft' } }),
      // 练习有两种「没审完」：AI 刚生成的草稿，和一致性自检没通过、被标成待复核的题。
      // 只数 `draft` 会让 `needs_review` 的题悄悄混进 `ready` 材料里。
      prisma.generatedExercise.count({
        where: { materialId, reviewStatus: { in: ['draft', 'needs_review'] }, retiredAt: null },
      }),
      // T12 起真实计数：词汇候选由「已采纳的抽取结果」物化而来（`materialCandidateRepo`），
      // 它们同样是"AI 产出的、等人点头的东西"。不计进来的话，材料会在候选还没人看过
      // 的情况下变成 `ready`，而 `ready` 是终态 —— 后续审核动作的前置断言会全部拒绝，
      // 这批候选就永远卡在 `draft` 里，既进不了词库也删不掉。
      prisma.vocabularyCandidate.count({ where: { materialId, reviewStatus: 'draft' } }),
      readDroppedUnverifiable(materialId),
    ]);

  return evaluateMaterialReviewGate({
    pendingExtractions,
    pendingExercises,
    pendingCandidates,
    droppedUnverifiable,
  });
}

/**
 * 按闸门结论推进材料状态（幂等、只动 `review_required`）。
 *
 * 为什么不处理其它状态：`analyzing`/`generating` 还没审完，`ready`/`partial` 已经是
 * 终局结论 —— 审核动作只可能把 `review_required` 往前推一步。别的状态一律原样返回，
 * 这样并发下重复调用不会把 `ready` 又推回 `review_required`。
 *
 * @param materialId 材料 id
 */
export async function settleMaterialReviewStatus(
  materialId: string,
): Promise<ReviewGateResult> {
  const gate = await readMaterialReviewGate(materialId);

  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { status: true },
  });
  if (!material) return gate;

  const current = material.status as MaterialStatus;
  if (current !== 'review_required') return gate;
  if (!canTransition(current, gate.nextStatus)) return gate;

  await prisma.learningMaterial.update({
    where: { id: materialId },
    data: { status: gate.nextStatus, statusReason: gate.reasonZh },
  });

  return gate;
}
