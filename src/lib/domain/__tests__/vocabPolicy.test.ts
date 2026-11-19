import { describe, expect, it } from 'vitest';
import { buildAssignmentCandidates, planVocabularyAssignment } from '../vocabPolicy';

describe('词汇预算策略', () => {
  it('0 预算不生成任务', () => {
    const plan = planVocabularyAssignment({ budgetMinutes: 0, dueReviewCount: 10, availableNewCount: 10 });
    expect(plan.reviewTarget).toBe(0);
    expect(plan.newTarget).toBe(0);
    expect(plan.modes).toEqual([]);
  });

  it('15 分钟档只复习，不给新词', () => {
    const plan = planVocabularyAssignment({ budgetMinutes: 15, dueReviewCount: 100, availableNewCount: 100 });
    expect(plan.reviewOnly).toBe(true);
    expect(plan.newTarget).toBe(0);
    expect(plan.modes).toEqual(['RECOGNIZE']);
    expect(plan.reviewTarget).toBeLessThanOrEqual(40);
    expect(plan.reviewTarget).toBeGreaterThan(0);
  });

  it('30 分钟档新词不超过 5 个', () => {
    const plan = planVocabularyAssignment({ budgetMinutes: 30, dueReviewCount: 0, availableNewCount: 100 });
    expect(plan.newTarget).toBe(5);
    expect(plan.modes).toContain('SPELL');
  });

  it('时间不足时压低新词量而不是复习', () => {
    const plan = planVocabularyAssignment({ budgetMinutes: 60, dueReviewCount: 30, availableNewCount: 100 });
    expect(plan.newTarget).toBeLessThanOrEqual(10);
    expect(plan.reviewTarget).toBeLessThanOrEqual(30);
    expect(plan.estimatedMinutes).toBeLessThanOrEqual(60);
  });

  it('词库自身上限优先于策略上限', () => {
    const plan = planVocabularyAssignment({
      budgetMinutes: 120,
      dueReviewCount: 80,
      availableNewCount: 100,
      deckReviewCap: 10,
      deckDailyNewTarget: 3,
    });
    expect(plan.reviewTarget).toBe(10);
    expect(plan.newTarget).toBe(3);
  });

  it('过期复习给出保留提示与优先级', () => {
    const plan = planVocabularyAssignment({
      budgetMinutes: 30,
      dueReviewCount: 60,
      availableNewCount: 10,
      maxOverdueDays: 5,
    });
    expect(plan.warnings.join()).toContain('保留在明天');
    expect(plan.priorityPolicy.review).toBe('P0');
    expect(plan.rationale).toContain('逾期 5 天');
  });
});

describe('候选排序', () => {
  it('到期更久的先排，弱项占新词名额', () => {
    const candidates = buildAssignmentCandidates(
      {
        reviews: [
          { itemId: 'r1', lemma: 'a', dueDate: '2026-11-18', overdueDays: 1 },
          { itemId: 'r2', lemma: 'b', dueDate: '2026-11-10', overdueDays: 9 },
        ],
        weaknesses: [{ itemId: 'w1', lemma: 'c' }],
        newItems: [
          { itemId: 'n1', lemma: 'd' },
          { itemId: 'n2', lemma: 'e' },
        ],
      },
      {
        reviewTarget: 2,
        newTarget: 2,
        priorityPolicy: { review: 'P0', weakness: 'P1', new: 'P3' },
        modes: ['RECOGNIZE', 'SPELL'],
      },
    );
    expect(candidates.map((c) => c.itemId)).toEqual(['r2', 'r1', 'w1', 'n1']);
    expect(candidates.map((c) => c.kind)).toEqual(['REVIEW', 'REVIEW', 'WEAKNESS', 'NEW']);
    expect(candidates[0].priority).toBe('P0');
  });
});
