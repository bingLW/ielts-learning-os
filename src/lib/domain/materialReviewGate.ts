/**
 * 材料审核闸门（纯函数，AC-03 / ADR-08 的"单点裁决"）。
 *
 * 一个问题：材料什么时候可以从 `review_required` 走到 `ready`？
 * 答案必须只有一处 —— 否则「还有 3 条 AI 结果没审」这种判断会散落在页面、action、
 * 后台脚本里各写一遍，迟早互相矛盾。所以这段逻辑做成零依赖纯函数，输入是三个
 * 待审计数 + 被丢弃计数，输出是"下一步该是什么状态"。
 *
 * 三条规则的**顺序不可调**（`droppedUnverifiable > 0` 时绝不能自动 ready：
 * 有内容没通过原文回验，等于有一部分材料我们没真正读懂，必须用户点头）。
 */

export interface ReviewGateInput {
  /** `ExtractionResult.reviewStatus === 'draft'` 的条数。 */
  pendingExtractions: number;
  /** `GeneratedExercise.reviewStatus ∈ {draft, needs_review}` 且未退役的条数（T11 起真实传入）。 */
  pendingExercises: number;
  /** `VocabularyCandidate.reviewStatus === 'draft'` 的条数（T12 起真实传入）。 */
  pendingCandidates: number;
  /** 来自 `ProcessingJob.progressJson.droppedUnverifiable`（回验未通过被丢弃的条数）。 */
  droppedUnverifiable: number;
}

export interface ReviewGateResult {
  /** 三类待审结果之和。 */
  pendingTotal: number;
  /** `pendingTotal === 0`（不代表可以 released，见 `requiresPartialConfirm`）。 */
  allReviewed: boolean;
  /** 有结果被丢弃且没有待审项：必须用户显式"先这样用"才能转 `partial`。 */
  requiresPartialConfirm: boolean;
  nextStatus: 'review_required' | 'ready' | 'partial';
  /** 面向用户的一句话（写入 `statusReason` 或直接显示）。 */
  reasonZh: string;
}

/** 防御性归一：负数/NaN 一律当 0，避免计数异常把闸门判反。 */
function safeCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * 判定审核闸门。
 *
 * @param input 见 `ReviewGateInput`
 */
export function evaluateMaterialReviewGate(input: ReviewGateInput): ReviewGateResult {
  const pendingExtractions = safeCount(input.pendingExtractions);
  const pendingExercises = safeCount(input.pendingExercises);
  const pendingCandidates = safeCount(input.pendingCandidates);
  const droppedUnverifiable = safeCount(input.droppedUnverifiable);

  const pendingTotal = pendingExtractions + pendingExercises + pendingCandidates;

  // ① 还有待审项 → 继续等审核（不管有没有丢弃，先把人要看的看完）
  if (pendingTotal > 0) {
    const parts: string[] = [];
    if (pendingExtractions > 0) parts.push(`${pendingExtractions} 条提取结果`);
    if (pendingExercises > 0) parts.push(`${pendingExercises} 道练习题`);
    if (pendingCandidates > 0) parts.push(`${pendingCandidates} 条词汇候选`);
    return {
      pendingTotal,
      allReviewed: false,
      requiresPartialConfirm: false,
      nextStatus: 'review_required',
      reasonZh: `还有 ${parts.join('、')}待你审核`,
    };
  }

  // ② 全审完了但有结果被丢弃 → 不能自动 ready，必须用户点"先这样用"
  if (droppedUnverifiable > 0) {
    return {
      pendingTotal,
      allReviewed: true,
      requiresPartialConfirm: true,
      nextStatus: 'review_required',
      reasonZh: `有 ${droppedUnverifiable} 条结果因原文依据无法核验已丢弃；确认后可转为「部分可用」`,
    };
  }

  // ③ 全部可核验且都审完了 → ready
  return {
    pendingTotal,
    allReviewed: true,
    requiresPartialConfirm: false,
    nextStatus: 'ready',
    reasonZh: '全部 AI 结果已审核，原文依据核验通过',
  };
}
