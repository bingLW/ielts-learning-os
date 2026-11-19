import { describe, expect, it } from 'vitest';
import {
  canCompleteIntervention,
  canResolveBarrier,
  canTransitionIntervention,
  computeFocusChange,
  nextInterventionStatuses,
  summarizeBarriers,
  type BarrierRowLike,
} from '../barrier';

function barrier(overrides: Partial<BarrierRowLike>): BarrierRowLike {
  return {
    id: 'b1',
    skill: 'LISTENING',
    status: 'ACTIVE',
    selectedFocus: false,
    archived: false,
    ...overrides,
  };
}

describe('computeFocusChange', () => {
  it('清掉其他聚焦项，只保留目标', () => {
    const rows = [
      barrier({ id: 'a', selectedFocus: true }),
      barrier({ id: 'b', skill: 'READING' }),
      barrier({ id: 'c' }),
    ];
    expect(computeFocusChange(rows, 'b')).toEqual({ ok: true, clearIds: ['a'] });
  });

  it('目标已聚焦时幂等', () => {
    const rows = [barrier({ id: 'a', selectedFocus: true })];
    expect(computeFocusChange(rows, 'a')).toEqual({ ok: true, clearIds: [] });
  });

  it('拒绝归档/非诊断中/不存在的目标', () => {
    expect(computeFocusChange([barrier({ archived: true })], 'b1').ok).toBe(false);
    expect(computeFocusChange([barrier({ status: 'RESOLVED' })], 'b1').ok).toBe(false);
    expect(computeFocusChange([], 'missing').ok).toBe(false);
  });
});

describe('intervention rules', () => {
  it('没有后测样本不能标记完成', () => {
    expect(canCompleteIntervention(null).ok).toBe(false);
    expect(canCompleteIntervention('ev-1').ok).toBe(true);
  });

  it('状态只能前进，DONE/ABANDONED 是终态', () => {
    expect(canTransitionIntervention('PLANNED', 'RUNNING')).toBe(true);
    expect(canTransitionIntervention('RUNNING', 'DONE')).toBe(true);
    expect(canTransitionIntervention('PLANNED', 'DONE')).toBe(true);
    expect(canTransitionIntervention('DONE', 'RUNNING')).toBe(false);
    expect(canTransitionIntervention('ABANDONED', 'PLANNED')).toBe(false);
    expect(canTransitionIntervention('DONE', 'DONE')).toBe(true);
    expect(nextInterventionStatuses('RUNNING')).toEqual(['RUNNING', 'DONE', 'ABANDONED']);
    expect(nextInterventionStatuses('DONE')).toEqual(['DONE']);
  });

  it('未知状态不炸页面，按终态处理', () => {
    const legacy = 'IN_PROGRESS' as unknown as Parameters<typeof nextInterventionStatuses>[0];
    expect(nextInterventionStatuses(legacy)).toEqual(['IN_PROGRESS']);
    expect(canTransitionIntervention(legacy, 'DONE')).toBe(false);
  });
});

describe('canResolveBarrier', () => {
  it('必须有带后测样本的已完成修复', () => {
    expect(canResolveBarrier([]).ok).toBe(false);
    expect(
      canResolveBarrier([{ status: 'DONE', postEvidenceId: null }]).ok,
    ).toBe(false);
    expect(
      canResolveBarrier([{ status: 'RUNNING', postEvidenceId: 'ev' }]).ok,
    ).toBe(false);
    expect(
      canResolveBarrier([{ status: 'DONE', postEvidenceId: 'ev' }]).ok,
    ).toBe(true);
  });
});

describe('summarizeBarriers', () => {
  it('归档不计入，聚焦全局唯一', () => {
    const rows = [
      barrier({ id: 'a', selectedFocus: true }),
      barrier({ id: 'b', skill: 'SPEAKING' }),
      barrier({ id: 'c', skill: 'WRITING', status: 'RESOLVED' }),
      barrier({ id: 'd', skill: 'READING', archived: true, status: 'RESOLVED' }),
    ];
    expect(summarizeBarriers(rows)).toEqual({
      activeCount: 2,
      resolvedCount: 1,
      focusId: 'a',
      focusSkill: 'LISTENING',
      skillsWithActive: ['LISTENING', 'SPEAKING'],
    });
  });

  it('没有聚焦时返回 null', () => {
    const stats = summarizeBarriers([barrier({})]);
    expect(stats.focusId).toBeNull();
    expect(stats.focusSkill).toBeNull();
  });
});
