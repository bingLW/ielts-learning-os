import { describe, expect, it } from 'vitest';
import {
  VOCAB_RETEST_OFFSETS,
  buildVocabRetestPlan,
  isVocabRetestDue,
  shouldScheduleVocabRetest,
  vocabRetestIdempotencyKey,
  vocabRetestNote,
} from '../vocabRetest';

describe('词汇延迟复测计划', () => {
  it('只有能回忆及以上才排复测', () => {
    expect(shouldScheduleVocabRetest('RECOGNIZED')).toBe(false);
    expect(shouldScheduleVocabRetest('RECALLED')).toBe(true);
    expect(shouldScheduleVocabRetest('CONTEXT_UNDERSTOOD')).toBe(true);
    expect(shouldScheduleVocabRetest('PRODUCTIVE_USE_VERIFIED')).toBe(true);
  });

  it('按隔日 / 7 天 / 30 天生成排期', () => {
    const plan = buildVocabRetestPlan({
      itemId: 'item1',
      lemma: 'abandon',
      dimension: 'MEANING_RECALL',
      status: 'RECALLED',
      baseDate: '2026-11-19',
    });
    expect(plan.map((step) => step.dueDate)).toEqual(['2026-11-20', '2026-11-26', '2026-12-19']);
    expect(plan.every((step) => step.retestType === 'DELAYED')).toBe(true);
    expect(plan).toHaveLength(VOCAB_RETEST_OFFSETS.length);
  });

  it('未达到能回忆时返回空计划', () => {
    expect(
      buildVocabRetestPlan({
        itemId: 'item1',
        lemma: 'abandon',
        dimension: 'MEANING_RECALL',
        status: 'RECOGNIZED',
        baseDate: '2026-11-19',
      }),
    ).toEqual([]);
  });

  it('幂等键包含词条、维度与到期日', () => {
    const key = vocabRetestIdempotencyKey('item1', 'SPELLING_RECALL', '2026-11-26');
    expect(key).toBe('vocab:item1:SPELLING_RECALL:DELAYED:2026-11-26');
  });

  it('备注前缀可精确匹配词条与维度', () => {
    const note = vocabRetestNote('item1', 'MEANING_RECALL', 'abandon');
    expect(note.startsWith('VOCAB|item1|MEANING_RECALL|')).toBe(true);
  });

  it('到期判定包含当天，不含未来', () => {
    expect(isVocabRetestDue('2026-11-19', '2026-11-19')).toBe(true);
    expect(isVocabRetestDue('2026-11-18', '2026-11-19')).toBe(true);
    expect(isVocabRetestDue('2026-11-20', '2026-11-19')).toBe(false);
  });
});
