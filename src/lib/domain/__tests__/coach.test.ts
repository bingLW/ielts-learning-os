import { describe, expect, it } from 'vitest';
import {
  a4DependencyWarning,
  aiLevelAllowedForAction,
  aiUsageIndependent,
  canUseAiAtStep,
  coachStepIndex,
  nextCoachStep,
  previousCoachStep,
  summarizeAiUsage,
} from '../coach';

describe('coach protocol', () => {
  it('步骤顺序：先尝试再诊断，最后回到证据', () => {
    expect(coachStepIndex('ATTEMPT')).toBe(0);
    expect(nextCoachStep('ATTEMPT')).toBe('DIAGNOSE');
    expect(nextCoachStep('RETEST')).toBe('EVIDENCE');
    expect(nextCoachStep('EVIDENCE')).toBeNull();
    expect(previousCoachStep('ATTEMPT')).toBeNull();
    expect(previousCoachStep('HINT')).toBe('DIAGNOSE');
  });

  it('第 1 步不允许请求 AI', () => {
    expect(canUseAiAtStep('ATTEMPT').ok).toBe(false);
    for (const step of ['DIAGNOSE', 'HINT', 'PRACTICE', 'RETEST', 'EVIDENCE'] as const) {
      expect(canUseAiAtStep(step).ok).toBe(true);
    }
  });
});

describe('ai usage rules', () => {
  it('改写/生成至少 A3', () => {
    expect(aiLevelAllowedForAction('A0', 'REWRITE').ok).toBe(false);
    expect(aiLevelAllowedForAction('A2', 'GENERATE').ok).toBe(false);
    expect(aiLevelAllowedForAction('A3', 'REWRITE').ok).toBe(true);
    expect(aiLevelAllowedForAction('A4', 'GENERATE').ok).toBe(true);
    expect(aiLevelAllowedForAction('A0', 'HINT').ok).toBe(true);
  });

  it('只有 A0 才算独立；A4 永远不算', () => {
    expect(aiUsageIndependent('A0', 'HINT')).toBe(true);
    expect(aiUsageIndependent('A1', 'HINT')).toBe(false);
    expect(aiUsageIndependent('A4', 'REWRITE')).toBe(false);
    expect(aiUsageIndependent('A0', 'OTHER')).toBe(true);
  });
});

describe('summarizeAiUsage', () => {
  it('统计 A4 占比与采纳情况', () => {
    const stats = summarizeAiUsage([
      { assistanceLevel: 'A0', actionType: 'OTHER', adoptedOrRejected: 'ADOPTED' },
      { assistanceLevel: 'A4', actionType: 'REWRITE', adoptedOrRejected: 'ADOPTED' },
      { assistanceLevel: 'A3', actionType: 'CORRECT', adoptedOrRejected: 'PARTIAL' },
      { assistanceLevel: 'A4', actionType: 'GENERATE', adoptedOrRejected: 'REJECTED' },
    ]);
    expect(stats).toEqual({
      total: 4,
      a4Count: 2,
      a4Share: 50,
      adoptedCount: 2,
      rejectedCount: 1,
      independentCount: 1,
    });
  });

  it('空记录不除零', () => {
    expect(summarizeAiUsage([]).a4Share).toBe(0);
  });

  it('A4 依赖阈值', () => {
    expect(a4DependencyWarning(30)).toBe(false);
    expect(a4DependencyWarning(30.1)).toBe(true);
    expect(a4DependencyWarning(0)).toBe(false);
  });
});
