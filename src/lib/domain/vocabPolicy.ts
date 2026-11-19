/**
 * 词汇任务的预算策略 —— 纯函数（v2.3 Phase 3）。
 *
 * 输入只是「预算 + 到期量 + 可学新词」，输出是当天的词汇任务目标。
 * 策略表在 `constants.ts` 的 `VOCAB_BUDGET_POLICY`，这里只做夹取与时间估算，
 * 不允许调用方各自硬编码「15 分钟只复习」之类的规则。
 */

import {
  VOCAB_BUDGET_POLICY,
  VOCAB_NEW_ASSIGN_CAP,
  VOCAB_REVIEW_CAP,
} from '../constants';
import type { TaskPriority } from '../types';
import type { VocabPracticeMode } from '../constants';

/** 单个词条的时间成本（秒）。来源：需求手册 §7 的预算估算口径。 */
export const VOCAB_SECONDS_PER_WORD = {
  REVIEW_RECOGNIZE: 20,
  REVIEW_SPELL: 35,
  NEW_INTRO: 40,
  NEW_PRACTICE: 60,
} as const;

export interface VocabularyPolicyInput {
  budgetMinutes: number;
  dueReviewCount: number;
  /** 词库中尚未接触、可分配的新词数量。 */
  availableNewCount: number;
  /** 词库自身的每日新词目标（可空）。 */
  deckDailyNewTarget?: number | null;
  /** 词库自身的复习上限（可空）。 */
  deckReviewCap?: number | null;
  /** 有证据的弱项数量（优先于普通新词）。 */
  weaknessCount?: number;
  /** 最久逾期天数，仅用于文案与优先级。 */
  maxOverdueDays?: number;
}

export interface VocabularyPolicyResult {
  reviewTarget: number;
  newTarget: number;
  modes: VocabPracticeMode[];
  estimatedMinutes: number;
  reviewOnly: boolean;
  priorityPolicy: {
    review: TaskPriority;
    weakness: TaskPriority;
    new: TaskPriority;
  };
  rationale: string;
  warnings: string[];
}

function tierFor(budgetMinutes: number) {
  const budget = Math.max(0, Math.round(budgetMinutes));
  const tier = VOCAB_BUDGET_POLICY.find(
    (entry) => budget >= entry.minMinutes && (entry.maxMinutes === null || budget <= entry.maxMinutes),
  );
  return tier ?? VOCAB_BUDGET_POLICY[VOCAB_BUDGET_POLICY.length - 1];
}

/**
 * 生成当日词汇目标。
 *
 * 约束顺序（不可调换）：
 * 1. 预算 ≤ 0 → 全部为 0，不生成任务；
 * 2. 复习优先，并受「复习上限 / 预算时间」双重夹取；
 * 3. 只有复习之外还有时间才分配新词；15 分钟档强制 0 新词；
 * 4. 新词量在时间估算下尽量贴近策略值，但不越界。
 */
export function planVocabularyAssignment(input: VocabularyPolicyInput): VocabularyPolicyResult {
  const budget = Math.max(0, Math.round(input.budgetMinutes));
  const dueReviewCount = Math.max(0, Math.round(input.dueReviewCount));
  const availableNewCount = Math.max(0, Math.round(input.availableNewCount));
  const warnings: string[] = [];

  if (budget <= 0) {
    return {
      reviewTarget: 0,
      newTarget: 0,
      modes: [],
      estimatedMinutes: 0,
      reviewOnly: true,
      priorityPolicy: { review: 'P0', weakness: 'P1', new: 'P3' },
      rationale: '当日没有词汇预算，不生成词汇任务。',
      warnings,
    };
  }

  const tier = tierFor(budget);
  const reviewCap = Math.max(
    0,
    Math.min(VOCAB_REVIEW_CAP, input.deckReviewCap ?? VOCAB_REVIEW_CAP),
  );

  const reviewSecondsPerWord = tier.modes.includes('SPELL')
    ? VOCAB_SECONDS_PER_WORD.REVIEW_SPELL
    : VOCAB_SECONDS_PER_WORD.REVIEW_RECOGNIZE;
  const reviewByTime = Math.floor((budget * 60 * 0.75) / reviewSecondsPerWord);
  let reviewTarget = Math.min(dueReviewCount, reviewCap, reviewByTime);

  if (dueReviewCount > 0 && reviewTarget < dueReviewCount) {
    warnings.push(
      `到期复习 ${dueReviewCount} 个，当日只安排 ${reviewTarget} 个；剩余复习保留在明天（复习优先于新词）。`,
    );
  }

  const reviewMinutes = Math.ceil((reviewTarget * reviewSecondsPerWord) / 60);
  let remainingMinutes = Math.max(0, budget - reviewMinutes);
  let newTarget = 0;

  if (!tier.reviewOnly && remainingMinutes > 0) {
    const desired = Math.min(
      tier.newTarget,
      input.deckDailyNewTarget ?? tier.newTarget,
      VOCAB_NEW_ASSIGN_CAP,
      availableNewCount,
    );
    const perNewSeconds = VOCAB_SECONDS_PER_WORD.NEW_INTRO + VOCAB_SECONDS_PER_WORD.NEW_PRACTICE;
    const newByTime = Math.floor((remainingMinutes * 60) / perNewSeconds);
    newTarget = Math.max(0, Math.min(desired, newByTime));
    if (newTarget < desired && availableNewCount > 0) {
      warnings.push(
        `预算只够 ${newTarget} 个新词（策略值 ${desired}）；不压缩复习来换新词量。`,
      );
    }
    remainingMinutes -= Math.ceil((newTarget * perNewSeconds) / 60);
  }

  // 弱项占用新词名额：有证据的弱项先排，仍受新词总量约束
  const weaknessCount = Math.max(0, Math.round(input.weaknessCount ?? 0));
  if (weaknessCount > 0 && newTarget > 0) {
    warnings.push(`其中 ${Math.min(weaknessCount, newTarget)} 个新词名额优先给有证据的弱项词条。`);
  }

  const modes = resolveModes(tier.modes, reviewTarget, newTarget);
  const estimatedMinutes =
    Math.min(
      budget,
      Math.ceil(
        (reviewTarget * reviewSecondsPerWord +
          newTarget *
            (VOCAB_SECONDS_PER_WORD.NEW_INTRO + VOCAB_SECONDS_PER_WORD.NEW_PRACTICE)) /
          60,
      ),
    );

  const overdue = Math.max(0, Math.round(input.maxOverdueDays ?? 0));
  const rationale = buildRationale({
    budget,
    tierGuidance: tier.guidanceZh,
    reviewTarget,
    newTarget,
    overdue,
  });

  return {
    reviewTarget,
    newTarget,
    modes,
    estimatedMinutes,
    reviewOnly: newTarget === 0,
    priorityPolicy: {
      review: 'P0',
      weakness: budget >= 60 ? 'P1' : 'P2',
      new: budget >= 120 ? 'P2' : 'P3',
    },
    rationale,
    warnings,
  };
}

function resolveModes(
  modes: readonly VocabPracticeMode[],
  reviewTarget: number,
  newTarget: number,
): VocabPracticeMode[] {
  if (reviewTarget === 0 && newTarget === 0) return [];
  const out = [...modes];
  if (newTarget === 0) {
    return out.filter((mode) => mode === 'RECOGNIZE' || mode === 'SPELL');
  }
  return out;
}

function buildRationale(input: {
  budget: number;
  tierGuidance: string;
  reviewTarget: number;
  newTarget: number;
  overdue: number;
}): string {
  const overdueText = input.overdue > 0 ? `（最久逾期 ${input.overdue} 天）` : '';
  return `${input.budget} 分钟档：复习 ${input.reviewTarget} 个${overdueText}，新词 ${input.newTarget} 个。${input.tierGuidance}`;
}

export interface AssignmentCandidate {
  itemId: string;
  lemma: string;
  kind: 'REVIEW' | 'NEW' | 'WEAKNESS';
  dueDate?: string | null;
  priority: TaskPriority;
  mode: VocabPracticeMode;
}

export interface CandidatePools {
  reviews: Array<{ itemId: string; lemma: string; dueDate: string; overdueDays: number }>;
  weaknesses: Array<{ itemId: string; lemma: string }>;
  newItems: Array<{ itemId: string; lemma: string }>;
}

/**
 * 按「到期复习 → 弱项 → 新词」排序并截断。
 * 返回顺序即 `sortOrder`；不修改输入数组。
 */
export function buildAssignmentCandidates(
  pools: CandidatePools,
  policy: Pick<VocabularyPolicyResult, 'reviewTarget' | 'newTarget' | 'priorityPolicy' | 'modes'>,
): AssignmentCandidate[] {
  const out: AssignmentCandidate[] = [];
  const reviewMode = policy.modes.includes('SPELL') ? 'SPELL' : 'RECOGNIZE';

  const reviews = [...pools.reviews].sort(
    (a, b) => b.overdueDays - a.overdueDays || a.dueDate.localeCompare(b.dueDate),
  );
  for (const review of reviews.slice(0, policy.reviewTarget)) {
    out.push({
      itemId: review.itemId,
      lemma: review.lemma,
      kind: 'REVIEW',
      dueDate: review.dueDate,
      priority: policy.priorityPolicy.review,
      mode: reviewMode,
    });
  }

  const weaknessSlots = Math.min(pools.weaknesses.length, policy.newTarget);
  for (const weakness of pools.weaknesses.slice(0, weaknessSlots)) {
    out.push({
      itemId: weakness.itemId,
      lemma: weakness.lemma,
      kind: 'WEAKNESS',
      priority: policy.priorityPolicy.weakness,
      mode: 'SPELL',
    });
  }

  const remainingNew = Math.max(0, policy.newTarget - weaknessSlots);
  for (const item of pools.newItems.slice(0, remainingNew)) {
    out.push({
      itemId: item.itemId,
      lemma: item.lemma,
      kind: 'NEW',
      priority: policy.priorityPolicy.new,
      mode: 'RECOGNIZE',
    });
  }

  return out;
}
