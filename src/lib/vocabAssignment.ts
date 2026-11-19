/**
 * 词汇任务落库（服务端共用，不是 Server Action）。
 *
 * 计划生成、手动生成、今日页补生成都走这里，保证：
 * - 一天的 `VocabularyAssignment` 只有一条（`assignmentDate` 唯一）；
 * - 预算不超过计划里 `VOCAB_REVIEW` 任务的分钟数；
 * - 候选只来自 ACTIVE 词库，且不重复安排同一词条。
 */

import type { Prisma } from '@prisma/client';
import { addDays, diffDays } from '@/lib/date';
import { buildAssignmentCandidates, planVocabularyAssignment } from '@/lib/domain/vocabPolicy';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type { VocabPracticeMode } from '@/lib/constants';

type Tx = Prisma.TransactionClient;

export interface EnsureAssignmentInput {
  assignmentDate: string;
  budgetMinutes: number;
  planTaskId?: string | null;
  /** 已存在时的处理：true = 只补 planTaskId 不重算。 */
  linkOnly?: boolean;
  /**
   * 重排场景：若当日分配尚未开始（没有练习会话、状态仍是 PLANNED/SENT），
   * 按新预算重算候选；已开始则只补关联，不动既有分配。
   */
  recomputeWhenUnstarted?: boolean;
}

export interface EnsureAssignmentResult {
  assignmentId: string | null;
  created: boolean;
  reviewTarget: number;
  newTarget: number;
  warnings: string[];
}

export async function ensureVocabularyAssignment(
  tx: Tx,
  input: EnsureAssignmentInput,
): Promise<EnsureAssignmentResult> {
  const existing = await tx.vocabularyAssignment.findUnique({
    where: { assignmentDate: input.assignmentDate },
    select: { id: true, reviewTarget: true, newTarget: true, planTaskId: true, status: true },
  });

  if (existing) {
    let replace = false;
    if (input.recomputeWhenUnstarted && (existing.status === 'PLANNED' || existing.status === 'SENT')) {
      const sessions = await tx.vocabularyPracticeSession.count({
        where: { assignmentId: existing.id },
      });
      replace = sessions === 0;
    }
    if (!replace) {
      if (input.planTaskId && existing.planTaskId !== input.planTaskId) {
        await tx.vocabularyAssignment.update({
          where: { id: existing.id },
          data: { planTaskId: input.planTaskId },
        });
      }
      return {
        assignmentId: existing.id,
        created: false,
        reviewTarget: existing.reviewTarget,
        newTarget: existing.newTarget,
        warnings: ['当日已有词汇任务，本次只补关联，不重复生成。'],
      };
    }
    // 尚未开始的当日分配：按新预算重算（不是历史数据，没有练习会话挂载）
    await tx.vocabularyAssignment.delete({ where: { id: existing.id } });
  }

  const budget = Math.max(0, Math.round(input.budgetMinutes));
  if (budget <= 0) {
    return { assignmentId: null, created: false, reviewTarget: 0, newTarget: 0, warnings: [] };
  }

  const deck = await tx.vocabularyDeck.findFirst({
    where: { archivedAt: null, status: 'ACTIVE' },
    orderBy: { updatedAt: 'desc' },
  });
  if (!deck) {
    return {
      assignmentId: null,
      created: false,
      reviewTarget: 0,
      newTarget: 0,
      warnings: ['还没有 ACTIVE 词库：词汇时间保留在计划里，先到「词库」页导入词表。'],
    };
  }

  const deckItems = await tx.vocabularyDeckItem.findMany({
    where: { deckId: deck.id },
    take: 3000,
    include: { item: { select: { id: true, lemma: true } } },
  });
  const itemIds = deckItems.map((row) => row.itemId);
  const states = await tx.vocabularyKnowledgeState.findMany({
    where: { itemId: { in: itemIds } },
  });
  const statesByItem = new Map<string, typeof states>();
  for (const state of states) {
    const list = statesByItem.get(state.itemId) ?? [];
    list.push(state);
    statesByItem.set(state.itemId, list);
  }

  const reviews: Array<{ itemId: string; lemma: string; dueDate: string; overdueDays: number }> = [];
  const weaknesses: Array<{ itemId: string; lemma: string }> = [];
  const newItems: Array<{ itemId: string; lemma: string }> = [];

  for (const row of deckItems) {
    const itemStates = statesByItem.get(row.itemId) ?? [];
    const meaning = itemStates.find((state) => state.dimension === 'MEANING_RECOGNITION');
    if (!meaning || meaning.status === 'UNKNOWN') {
      newItems.push({ itemId: row.itemId, lemma: row.item.lemma });
      continue;
    }
    if (meaning.status === 'INTRODUCED' && meaning.evidenceCount >= 2) {
      weaknesses.push({ itemId: row.itemId, lemma: row.item.lemma });
    }
    const verifiedDate = meaning.lastVerifiedAt ?? addDays(input.assignmentDate, -30);
    const overdueDays = Math.max(0, diffDays(verifiedDate, input.assignmentDate));
    if (overdueDays >= 3) {
      reviews.push({
        itemId: row.itemId,
        lemma: row.item.lemma,
        dueDate: addDays(verifiedDate, 3),
        overdueDays,
      });
    }
  }

  const policy = planVocabularyAssignment({
    budgetMinutes: budget,
    dueReviewCount: reviews.length,
    availableNewCount: newItems.length,
    deckDailyNewTarget: deck.dailyNewTarget,
    deckReviewCap: deck.reviewCap,
    weaknessCount: weaknesses.length,
    maxOverdueDays: reviews[0]?.overdueDays ?? 0,
  });

  const candidates = buildAssignmentCandidates(
    { reviews, weaknesses, newItems },
    policy,
  );

  const created = await tx.vocabularyAssignment.create({
    data: {
      assignmentDate: input.assignmentDate,
      budgetMinutes: budget,
      reviewTarget: policy.reviewTarget,
      newTarget: policy.newTarget,
      estimatedMinutes: policy.estimatedMinutes,
      status: 'PLANNED',
      priorityPolicyJson: stringify({
        ...policy.priorityPolicy,
        modes: policy.modes,
      }),
      rationale: policy.rationale,
      deckId: deck.id,
      planTaskId: input.planTaskId ?? null,
      externalDeckId: deck.externalDeckId,
      items: {
        create: candidates.map((candidate, index) => ({
          itemId: candidate.itemId,
          priority: candidate.priority,
          kind: candidate.kind,
          mode: candidate.mode as VocabPracticeMode,
          sortOrder: index,
        })),
      },
    },
  });

  return {
    assignmentId: created.id,
    created: true,
    reviewTarget: policy.reviewTarget,
    newTarget: policy.newTarget,
    warnings: policy.warnings,
  };
}

/** 手动「生成今日词汇」：无计划任务时也给一条可执行的分配。 */
export async function generateVocabularyAssignmentForDate(
  assignmentDate: string,
  budgetMinutes: number,
): Promise<EnsureAssignmentResult> {
  return prisma.$transaction((tx) =>
    ensureVocabularyAssignment(tx, { assignmentDate, budgetMinutes }),
  );
}
