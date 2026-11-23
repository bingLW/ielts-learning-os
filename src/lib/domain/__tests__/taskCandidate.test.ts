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
import {
  CANDIDATE_DEFAULT_MINUTES,
  CANDIDATE_FALLBACK_MINUTES,
  LISTENING_MODES,
  MATERIAL_EXERCISE_TYPES,
  SPEAKING_TASK_TYPES,
} from '../../constants';
import { DIAG_TASK_TYPES } from '@/lib/diagnostic/constants';

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

describe('8 源全覆盖与两张分钟表', () => {
  it('CANDIDATE_SOURCE_KINDS 恰好 8 个且与优先级表一一对应', () => {
    expect(CANDIDATE_SOURCE_KINDS).toHaveLength(8);
    expect(Object.keys(CANDIDATE_SOURCE_PRIORITY).sort()).toEqual(
      [...CANDIDATE_SOURCE_KINDS].sort(),
    );
  });

  it('「本来就没有时长」的三个来源在 DEFAULT 表里，其余五个在 FALLBACK 表里', () => {
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES).sort()).toEqual(['LAB', 'PROBE', 'QUESTION']);
    expect(Object.keys(CANDIDATE_FALLBACK_MINUTES).sort()).toEqual([
      'EGIU',
      'MATERIAL',
      'RETEST',
      'REVIEW',
      'VOCAB',
    ]);
    // 两张表不许有交集：一个来源只能属于"本来没有"或"本该有却没有"
    const overlap = Object.keys(CANDIDATE_DEFAULT_MINUTES).filter((key) =>
      Object.keys(CANDIDATE_FALLBACK_MINUTES).includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it('两张表的键集合必须**互补**：并集 = 8 个来源、交集为空', () => {
    const derivedOnly = Object.keys(CANDIDATE_DEFAULT_MINUTES).sort();
    const withField = Object.keys(CANDIDATE_FALLBACK_MINUTES).sort();
    expect([...derivedOnly, ...withField].sort()).toEqual([...CANDIDATE_SOURCE_KINDS].sort());
  });

  it('PROBE 是 10 分钟（不是 15）', () => {
    expect(CANDIDATE_DEFAULT_MINUTES.PROBE).toBe(10);
  });

  it('QUESTION 不可拍平：开放题 15 / 简答 6 / 单选 3 各不相同', () => {
    const table = CANDIDATE_DEFAULT_MINUTES.QUESTION;
    expect(table.OPEN_TASK).toBe(15);
    expect(table.SHORT_ANSWER).toBe(6);
    expect(table.MCQ).toBe(3);
    // 拍平成一个数会同时毁掉两端：开放题少算 5 分钟、单选多算 12 分钟
    expect(new Set(Object.values(table)).size).toBeGreaterThan(1);
  });

  it('QUESTION 的键 = 诊断域 ∪ 材料域（共 8 个），LAB = 听力 ∪ 口语（共 17 个）', () => {
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES.QUESTION)).toHaveLength(
      new Set([...DIAG_TASK_TYPES, ...MATERIAL_EXERCISE_TYPES]).size,
    );
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES.LAB)).toHaveLength(
      new Set([...LISTENING_MODES, ...SPEAKING_TASK_TYPES]).size,
    );
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES.LAB)).toHaveLength(17);
  });
});

describe('映射表的键集合必须由枚举钉死（NaN 防线）', () => {
  it('QUESTION 表覆盖诊断域与材料域的**每一个**枚举值', () => {
    for (const taskType of [...DIAG_TASK_TYPES, ...MATERIAL_EXERCISE_TYPES]) {
      // 缺键 → 采集时 undefined → estMinutes NaN → 装箱 Σ 变 NaN → 任务全被挤出
      // 且**不报错**，所以只能靠这条断言在测试期拦住
      expect(
        CANDIDATE_DEFAULT_MINUTES.QUESTION[taskType as 'MCQ'],
        `taskType=${taskType} 在派生表里缺键`,
      ).toBeGreaterThan(0);
    }
  });

  it('LAB 表覆盖 LISTENING_MODES 与 SPEAKING_TASK_TYPES 的每一个枚举值', () => {
    for (const mode of LISTENING_MODES) {
      expect(
        CANDIDATE_DEFAULT_MINUTES.LAB[mode as 'BLIND'],
        `听力 mode=${mode} 在派生表里缺键`,
      ).toBeGreaterThan(0);
    }
    for (const taskType of SPEAKING_TASK_TYPES) {
      expect(
        CANDIDATE_DEFAULT_MINUTES.LAB[taskType as 'READ_ALOUD'],
        `口语 taskType=${taskType} 在派生表里缺键`,
      ).toBeGreaterThan(0);
    }
  });

  it('LAB 表里没有枚举外的死配置（表里有、枚举没有 → 永远用不上）', () => {
    const known = new Set<string>([...LISTENING_MODES, ...SPEAKING_TASK_TYPES]);
    const extra = Object.keys(CANDIDATE_DEFAULT_MINUTES.LAB).filter((key) => !known.has(key));
    expect(extra, `派生表里有枚举外的键：${extra.join(', ')}`).toEqual([]);
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
