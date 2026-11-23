/**
 * 候选身份键与去重（T03）。
 *
 * 两个 bug 都是"看起来能跑、事后无法解释"的类型：
 * - `estMinutes` 进身份 → 用户把材料任务从 15 改 20 分钟，历史里同一件事变成两条；
 * - 去重按身份分组 → `REVIEW` 与 `PROBE` 永远合不起来，缺口被排两遍。
 *
 * 反过来，合并过头也会出事（`QUESTION` 两条不同来源被合成一条），所以下面
 * 同时钉「该合的合」与「不该合的不合」。
 */

import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_SOURCE_KINDS,
  CANDIDATE_SOURCE_PRIORITY,
  candidateKeyOf,
  dedupeCandidates,
  dedupeGroupOf,
  evaluatePrerequisites,
  gapKeyOf,
  type TaskCandidateDraft,
} from '../taskCandidate';
import { CANDIDATE_DEFAULT_MINUTES } from '../../constants';

function draft(over: Partial<TaskCandidateDraft> = {}): TaskCandidateDraft {
  const base: TaskCandidateDraft = {
    candidateKey: '',
    sourceKind: 'REVIEW',
    sourceRef: 'r1',
    module: 'READING',
    targetSkill: 'READING',
    primarySkill: 'READING',
    track: 'IELTS_PREPARATION',
    skillGapKey: gapKeyOf('OFFICIAL', 'READING', 'detail_scanning'),
    title: '复习：阅读细节题',
    estMinutes: 10,
    minMinutes: 5,
    maxBlockMinutes: null,
    prerequisites: [],
    validationStatus: 'RUBRIC',
    difficultyScore: null,
    isAiSuggested: false,
    aiCallLogId: null,
    expectedOutput: null,
    meta: { estMinutesSource: 'SOURCE' },
    ...over,
  };
  return { ...base, candidateKey: over.candidateKey ?? candidateKeyOf(base) };
}

describe('candidateKeyOf：身份不含时长', () => {
  it('改 estMinutes → key 不变（载荷不是身份）', () => {
    const a = draft({ estMinutes: 10 });
    const b = draft({ estMinutes: 20 });
    expect(a.candidateKey).toBe(b.candidateKey);
  });

  it('改 sourceRef → key 变', () => {
    expect(draft({ sourceRef: 'r1' }).candidateKey).not.toBe(draft({ sourceRef: 'r2' }).candidateKey);
  });

  it('改 module → key 变', () => {
    expect(draft({ module: 'READING' }).candidateKey).not.toBe(draft({ module: 'WRITING' }).candidateKey);
  });

  it('sourceRef 为 null 用 none 占位，key 形状稳定', () => {
    expect(draft({ sourceRef: null }).candidateKey).toBe('REVIEW:none:READING');
  });
});

describe('dedupeGroupOf：证据类按维度、其它按身份', () => {
  it('REVIEW / RETEST / PROBE 同维度 → 同一组（否则永远合不起来）', () => {
    const group = draft({ sourceKind: 'REVIEW' });
    const retest = draft({ sourceKind: 'RETEST', sourceRef: 'rr1' });
    const probe = draft({ sourceKind: 'PROBE', sourceRef: 'probe:READING|detail_scanning' });
    expect(dedupeGroupOf(group)).toBe(dedupeGroupOf(retest));
    expect(dedupeGroupOf(group)).toBe(dedupeGroupOf(probe));
  });

  it('不同维度 → 不同组', () => {
    const a = draft({ skillGapKey: gapKeyOf('OFFICIAL', 'READING', 'detail_scanning') });
    const b = draft({ skillGapKey: gapKeyOf('OFFICIAL', 'READING', 'gist') });
    expect(dedupeGroupOf(a)).not.toBe(dedupeGroupOf(b));
  });

  it('QUESTION / LAB / EGIU 各自成组（不跨来源合并）', () => {
    const q1 = draft({ sourceKind: 'QUESTION', sourceRef: 'q1' });
    const q2 = draft({ sourceKind: 'QUESTION', sourceRef: 'q2' });
    expect(dedupeGroupOf(q1)).not.toBe(dedupeGroupOf(q2));
    expect(dedupeGroupOf(q1)).toBe(q1.candidateKey);
  });
});

describe('dedupeCandidates：该合的合，不该合的不合', () => {
  it('REVIEW + PROBE 同维度 → 保留 REVIEW，dropped 写清被谁合并', () => {
    const review = draft({ sourceKind: 'REVIEW', title: '复习：阅读细节题' });
    const probe = draft({
      sourceKind: 'PROBE',
      sourceRef: 'probe:READING|detail_scanning',
      title: '补测：阅读细节题',
    });
    const result = dedupeCandidates([probe, review]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].sourceKind).toBe('REVIEW');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].sourceKind).toBe('PROBE');
    expect(result.dropped[0].why).toContain('REVIEW');
    expect(result.dropped[0].why).toContain('保留优先级更高');
  });

  it('两条 QUESTION 同 module 不同 sourceRef → 不合并', () => {
    const a = draft({ sourceKind: 'QUESTION', sourceRef: 'q1', title: '题 1' });
    const b = draft({ sourceKind: 'QUESTION', sourceRef: 'q2', title: '题 2' });
    const result = dedupeCandidates([a, b]);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it('输出顺序确定性：按输入首次出现的组顺序', () => {
    const probe = draft({ sourceKind: 'PROBE', sourceRef: 'p1' });
    const vocab = draft({ sourceKind: 'VOCAB', sourceRef: 'v1', skillGapKey: null });
    const result = dedupeCandidates([probe, vocab]);
    expect(result.kept.map((row) => row.sourceKind)).toEqual(['PROBE', 'VOCAB']);
  });
});

describe('8 源全覆盖与派生分钟表', () => {
  it('CANDIDATE_SOURCE_KINDS 恰好 8 个且与优先级表一一对应', () => {
    expect(CANDIDATE_SOURCE_KINDS).toHaveLength(8);
    expect(Object.keys(CANDIDATE_SOURCE_PRIORITY).sort()).toEqual(
      [...CANDIDATE_SOURCE_KINDS].sort(),
    );
  });

  it('每个来源都有派生分钟（缺一个就会在采集时静默变 0）', () => {
    for (const kind of CANDIDATE_SOURCE_KINDS) {
      expect(CANDIDATE_DEFAULT_MINUTES[kind], kind).toBeGreaterThan(0);
    }
  });
});

describe('evaluatePrerequisites', () => {
  const ctx = {
    stageCode: 'S2_A2_B1' as const,
    stageOrder: { S0_PREP: 0, S1_A0_A2: 1, S2_A2_B1: 2, S3_B1_IELTS: 3 },
    readyMaterialIds: new Set(['m1']),
    approvedExerciseIds: new Set<string>(),
    confirmedTranscriptAssetIds: new Set<string>(),
    completedLessonIds: new Set(['l1']),
    evidenceIds: new Set(['e1']),
  };

  it('满足全部前置 → ready', () => {
    const result = evaluatePrerequisites(
      [
        { kind: 'STAGE_AT_LEAST', code: 'S1_A0_A2' },
        { kind: 'MATERIAL_READY', materialId: 'm1' },
        { kind: 'UNIT_ORDER', lessonId: 'l2', requiresLessonId: 'l1' },
      ],
      ctx,
    );
    expect(result.ready).toBe(true);
    expect(result.unmet).toEqual([]);
  });

  it('阶段不够 / 练习未审核 → 未满足项逐条返回（不是只返回第一个）', () => {
    const result = evaluatePrerequisites(
      [
        { kind: 'STAGE_AT_LEAST', code: 'S3_B1_IELTS' },
        { kind: 'EXERCISE_APPROVED', exerciseId: 'ex1' },
      ],
      ctx,
    );
    expect(result.ready).toBe(false);
    expect(result.unmet).toHaveLength(2);
  });
});
