import { describe, expect, it } from 'vitest';
import {
  advanceDimension,
  emptyDimensionStates,
  evidencePromotesDimension,
  mergeStatus,
  statusForEvidence,
  type DimensionState,
} from '../vocabMastery';

function state(overrides: Partial<DimensionState> = {}): DimensionState {
  return {
    dimension: 'MEANING_RECOGNITION',
    status: 'UNKNOWN',
    confidence: 'LOW',
    evidenceCount: 0,
    lastVerifiedAt: null,
    ...overrides,
  };
}

describe('多维掌握推进', () => {
  it('七个维度独立初始化', () => {
    const states = emptyDimensionStates();
    expect(states).toHaveLength(7);
    expect(states.every((entry) => entry.status === 'UNKNOWN')).toBe(true);
  });

  it('答错降到已接触，不回到未接触', () => {
    const next = advanceDimension(state({ status: 'RECOGNIZED', evidenceCount: 2 }), {
      mode: 'RECOGNIZE',
      result: 'INCORRECT',
      businessDate: '2026-11-19',
    });
    expect(next.status).toBe('INTRODUCED');
    expect(next.confidence).toBe('LOW');
    expect(next.evidenceCount).toBe(3);
  });

  it('首次答对到能识别，换天再对推进到能回忆', () => {
    const first = advanceDimension(state(), {
      mode: 'RECOGNIZE',
      result: 'CORRECT',
      businessDate: '2026-11-18',
    });
    expect(first.status).toBe('RECOGNIZED');
    expect(first.lastVerifiedAt).toBe('2026-11-18');

    const second = advanceDimension(first, {
      mode: 'RECOGNIZE',
      result: 'CORRECT',
      businessDate: '2026-11-19',
      priorVerifiedDate: '2026-11-18',
    });
    expect(second.status).toBe('RECALLED');
  });

  it('同一天重复答对不虚增等级', () => {
    const first = advanceDimension(state(), {
      mode: 'RECOGNIZE',
      result: 'CORRECT',
      businessDate: '2026-11-19',
    });
    const again = advanceDimension(first, {
      mode: 'RECOGNIZE',
      result: 'CORRECT',
      businessDate: '2026-11-19',
    });
    expect(again.status).toBe('RECOGNIZED');
    expect(again.evidenceCount).toBe(2);
  });

  it('模式与维度不匹配时不改动状态', () => {
    const before = state({ status: 'RECOGNIZED', evidenceCount: 2 });
    const after = advanceDimension(before, {
      mode: 'LISTEN',
      result: 'CORRECT',
      businessDate: '2026-11-19',
    });
    expect(after).toBe(before);
  });

  it('拼写维度由默写推进，且封顶为能回忆', () => {
    let current: DimensionState = {
      ...state(),
      dimension: 'SPELLING_RECALL',
    };
    current = advanceDimension(current, {
      mode: 'DICTATION',
      result: 'CORRECT',
      businessDate: '2026-11-18',
    });
    current = advanceDimension(current, {
      mode: 'DICTATION',
      result: 'CORRECT',
      businessDate: '2026-11-19',
      priorVerifiedDate: '2026-11-18',
    });
    expect(current.status).toBe('RECALLED');
  });
});

describe('证据门槛', () => {
  it('产出使用只接受 E4/E5', () => {
    expect(evidencePromotesDimension('PRODUCTIVE_USE', 'E3')).toBe(false);
    expect(evidencePromotesDimension('PRODUCTIVE_USE', 'E4')).toBe(true);
    expect(statusForEvidence('PRODUCTIVE_USE', 'E5')).toBe('PRODUCTIVE_USE_VERIFIED');
  });

  it('语境理解需要 E2', () => {
    expect(evidencePromotesDimension('CONTEXT_UNDERSTANDING', 'E1')).toBe(false);
    expect(statusForEvidence('CONTEXT_UNDERSTANDING', 'E2')).toBe('CONTEXT_UNDERSTOOD');
  });

  it('合并只升不降', () => {
    expect(mergeStatus('RECALLED', 'RECOGNIZED')).toBe('RECALLED');
    expect(mergeStatus('UNKNOWN', 'INTRODUCED')).toBe('INTRODUCED');
  });
});

describe('证据等级换算', () => {
  it('A4 一律 E0，迁移证据 E5', async () => {
    const { toEvidenceGrade } = await import('../vocabMastery');
    expect(toEvidenceGrade({ evidenceType: 'TRANSFER', level: 'FULL', assistanceLevel: 'A4' })).toBe('E0');
    expect(toEvidenceGrade({ evidenceType: 'TRANSFER', level: 'FULL', assistanceLevel: 'A0' })).toBe('E5');
    expect(toEvidenceGrade({ evidenceType: 'APPLIED_TASK', level: 'STANDARD', assistanceLevel: 'A0' })).toBe('E4');
    expect(toEvidenceGrade({ evidenceType: 'BASELINE', level: 'QUICK', assistanceLevel: 'A0' })).toBe('E1');
  });
});
