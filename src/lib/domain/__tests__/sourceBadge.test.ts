/**
 * v2.7 T06a：来源徽章词表层断言（`41 §2.5.3`，G-13 ⑥⑦）。
 * 渲染链层的断言在 `components/planner/__tests__/sourceBadge.render.test.tsx`（T12）。
 */

import { describe, expect, it } from 'vitest';

import { resolveSourceBadge, type BadgeTaskInput } from '../sourceBadge';
import type { CandidateSourceKind } from '../taskCandidate';

function task(over: Partial<BadgeTaskInput> = {}): BadgeTaskInput {
  return {
    sourceKind: 'CORE',
    module: 'LISTENING',
    candidateId: 'c-1',
    ...over,
  };
}

describe('PROBE 与 RETEST：计划层合并、展示层分离', () => {
  it('同 sourceKind 的两种任务徽章文案必须不同', () => {
    const probe = resolveSourceBadge(task(), { sourceKind: 'PROBE' });
    const retest = resolveSourceBadge(task(), { sourceKind: 'RETEST' });
    expect(probe.label).not.toBe(retest.label);
    expect(probe.tone).toBe('probe');
    expect(retest.tone).toBe('retest');
    expect(probe.label).toBe('补测（证据不足）');
    expect(retest.label).toBe('到期复测');
  });

  it('PROBE 整条词表不含「弱项/薄弱/需强化」（AC-6）', () => {
    const probe = resolveSourceBadge(task(), { sourceKind: 'PROBE' });
    const rendered = `${probe.label}|${probe.tone}`;
    for (const word of ['弱项', '薄弱', '需强化']) {
      expect(rendered.includes(word)).toBe(false);
    }
  });

  it('candidateId 为空时回落到任务自身来源，不反查、不抛异常', () => {
    const badge = resolveSourceBadge(task({ candidateId: null }), { sourceKind: 'PROBE' });
    expect(badge.label).toBe('阶段核心');
    expect(() => resolveSourceBadge(task({ candidateId: null }), null)).not.toThrow();
  });

  it('candidateId 存在但候选已清理时也不抛异常', () => {
    const cleaned = task({ candidateId: 'gone', sourceKind: 'RETEST', module: 'EVIDENCE_RETEST' });
    expect(() => resolveSourceBadge(cleaned, null)).not.toThrow();
    expect(resolveSourceBadge(cleaned, null).label).toBe('证据复测');
  });

  it('不用 module 兜底：module 相同但 candidateId 指向不同来源 → 徽章不同', () => {
    const a = resolveSourceBadge(task(), { sourceKind: 'PROBE' });
    const b = resolveSourceBadge(task(), { sourceKind: 'RETEST' });
    expect(a.label).not.toBe(b.label);
  });

  it('其余来源各自可辨（穷举，防空集）', () => {
    const expected: Record<Exclude<CandidateSourceKind, 'PROBE' | 'RETEST'>, string> = {
      REVIEW: '复习',
      VOCAB: '阶段核心',
      MATERIAL: '材料任务',
      QUESTION: '阶段核心',
      LAB: '阶段核心',
      EGIU: '阶段核心',
    };
    for (const [source, label] of Object.entries(expected)) {
      expect(resolveSourceBadge(task(), { sourceKind: source as CandidateSourceKind }).label).toBe(
        label,
      );
    }
  });
});
