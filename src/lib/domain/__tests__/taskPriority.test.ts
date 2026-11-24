/**
 * 评分层（T04）：七因子、默认权重、分层、`factorsJson` 形状。
 *
 * 这份测试的重点不是"跑通"，而是**四条容易做得看起来对的陷阱**：
 *
 * 1. 无周期时 `goalRelevance` 必须是**显式** `0.50`，不能靠公式自然得出 `1.00`；
 * 2. `P0` 不由分数决定 —— 要证的是"到期复习**不会被**高分拓展挤掉"，不是"它得了 P0"；
 * 3. `evidenceStrength` 无缺口是 `0.30`（中性偏低），不是打压到 `0`；
 * 4. `weightsVersion` 与权重必须**真的参与计算**，不能只被存下来。
 *
 * 期望值一律手抄（`0.30` / `0.50` / `0.60` / `0.42` / `0.24`…），不从
 * `DEFAULT_WEIGHTS` 反查 —— 那张表改一次，反查版测试会一起自洽地通过（`41 §1.9` A-2）。
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_DEFAULT_MINUTES,
  DEFAULT_PRIORITY_WEIGHTS,
  EVIDENCE_CONFIDENCES,
  PRIORITY_CONFIDENCE_WEIGHT,
  PRIORITY_FACTOR_KEYS,
  PRIORITY_NEUTRAL_VALUE,
  PRIORITY_THRESHOLDS,
  WEAKNESS_MIN_QUESTIONS,
} from '@/lib/constants';
import { addDays } from '@/lib/date';
import type { SkillGapDraft } from '@/lib/domain/skillGap';
import { gapKeyOf, type PrerequisiteContext, type TaskCandidateDraft } from '@/lib/domain/taskCandidate';
import {
  DEFAULT_WEIGHTS,
  FACTOR_LABEL_ZH,
  WEIGHTS_VERSION,
  orderDecisions,
  priorityOf,
  scoreCandidate,
  toFactorsJson,
  weightedScore,
  type FactorTrace,
  type PriorityWeights,
  type ScoreContext,
  type TaskPriorityDecisionDraft,
} from '@/lib/domain/taskPriority';
import { validatePriorityWeights } from '@/lib/schema/planner';

const AS_OF = '2026-03-10';

/** 全满足的前置条件上下文（不关心的测试都用它）。 */
function prerequisitesAllMet(): PrerequisiteContext {
  return {
    stageCode: 'S3_B1_IELTS',
    stageOrder: { S0_PREP: 0, S1_A0_A2: 1, S2_A2_B1: 2, S3_B1_IELTS: 3 },
    readyMaterialIds: new Set(['m1']),
    approvedExerciseIds: new Set(['e1']),
    confirmedTranscriptAssetIds: new Set(['a1']),
    completedLessonIds: new Set(['l0']),
    evidenceIds: new Set(['ev1']),
  };
}

function gap(over: Partial<SkillGapDraft> = {}): SkillGapDraft {
  return {
    dimensionKind: 'OFFICIAL',
    skill: 'READING',
    subskill: 'detail_scanning',
    kind: 'GAP',
    confidence: 'HIGH',
    evidenceCount: 12,
    independentCount: 8,
    freshnessDays: 3,
    coverageRatio: 0.5,
    severity: 0.4,
    reason: '细节题准确率 0.5，低于目标',
    evidenceIds: ['ev1', 'ev2'],
    missingEvidence: [],
    evidenceQuestions: 12,
    repeatedErrorCount: 4,
    stale: false,
    ...over,
  };
}

function candidate(over: Partial<TaskCandidateDraft> = {}): TaskCandidateDraft {
  const base: TaskCandidateDraft = {
    candidateKey: 'READING:review:r1:READING',
    sourceKind: 'REVIEW',
    sourceRef: 'review:r1',
    module: 'READING',
    targetSkill: 'READING',
    primarySkill: 'READING',
    track: 'IELTS_PREPARATION',
    skillGapKey: gapKeyOf('OFFICIAL', 'READING', 'detail_scanning'),
    title: '复习：阅读细节题',
    estMinutes: 10,
    minMinutes: 5,
    maxBlockMinutes: null,
    dueDate: null,
    prerequisites: [],
    validationStatus: 'VERIFIED',
    difficultyScore: null,
    isAiSuggested: false,
    aiCallLogId: null,
    expectedOutput: null,
    meta: { estMinutesSource: 'SOURCE' },
    ...over,
  };
  return base;
}

function ctx(over: Partial<ScoreContext> = {}): ScoreContext {
  return {
    asOfDate: AS_OF,
    budgetMinutes: 60,
    minTaskMinutes: 5,
    goal: {
      track: 'IELTS_PREPARATION',
      targetValue: '6.5',
      targetDate: addDays(AS_OF, 60),
      skillTargets: { READING: 6.5, LISTENING: 6 },
      hasActiveCycle: true,
    },
    gaps: [gap()],
    weights: DEFAULT_WEIGHTS,
    weightsVersion: WEIGHTS_VERSION,
    prerequisites: prerequisitesAllMet(),
    ...over,
  };
}

// ───────────────────────── ② 默认权重 ─────────────────────────

describe('② 默认权重之和为 1', () => {
  it('|Σ−1| < 1e-9，且恰好 7 个因子', () => {
    const sum = PRIORITY_FACTOR_KEYS.reduce((acc, key) => acc + DEFAULT_PRIORITY_WEIGHTS[key], 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(PRIORITY_FACTOR_KEYS.length).toBe(7);
    // 逐个手抄（改权重必须是有意识的动作，不能"顺手调一下"）
    expect(DEFAULT_PRIORITY_WEIGHTS).toEqual({
      urgency: 0.22,
      goalRelevance: 0.18,
      evidenceStrength: 0.2,
      errorRecurrence: 0.12,
      prerequisiteReady: 0.1,
      timeCost: 0.1,
      preferenceFit: 0.08,
    });
  });

  it('每个因子都有人话名（解释面板不会显示裸键名）', () => {
    for (const key of PRIORITY_FACTOR_KEYS) {
      expect(FACTOR_LABEL_ZH[key], key).toBeTruthy();
      expect(FACTOR_LABEL_ZH[key], key).not.toBe(key);
    }
  });
});

// ───────────────────────── ① 七因子单调 ─────────────────────────

describe('① 七个因子各自单调（输入变强 → 因子不减）', () => {
  const nonDecreasing = (values: number[], label: string) => {
    expect(values.length).toBe(5);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!, `${label} 第 ${i} 档`).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  };

  it('urgency：逾期越久越高，无到期日最低', () => {
    const dueDates = [null, addDays(AS_OF, 3), AS_OF, addDays(AS_OF, -1), addDays(AS_OF, -5)];
    const values = dueDates.map(
      (dueDate) => scoreCandidate(candidate({ dueDate }), ctx()).factors.urgency,
    );
    nonDecreasing(values, 'urgency');
    expect(values[0]).toBe(0);
    expect(values[4]).toBe(1);
  });

  it('goalRelevance：剩余天数越少越高', () => {
    const remaining = [120, 90, 45, 10, 0];
    const values = remaining.map((days) =>
      scoreCandidate(
        candidate(),
        ctx({
          goal: {
            track: 'IELTS_PREPARATION',
            targetValue: '6.5',
            targetDate: addDays(AS_OF, days),
            skillTargets: { READING: 6.5 },
            hasActiveCycle: true,
          },
        }),
      ).factors.goalRelevance,
    );
    nonDecreasing(values, 'goalRelevance');
    expect(values[0]).toBe(0);
    expect(values[4]).toBe(1);
  });

  it('evidenceStrength：严重度 0 → 1 单调，且 HIGH 权重为 1', () => {
    const severities = [0, 0.25, 0.5, 0.75, 1];
    const values = severities.map(
      (severity) => scoreCandidate(candidate(), ctx({ gaps: [gap({ severity })] })).factors.evidenceStrength,
    );
    nonDecreasing(values, 'evidenceStrength');
    expect(values[0]).toBe(0);
    expect(values[4]).toBe(1);
  });

  it('errorRecurrence：重复次数越多越高（分母 = WEAKNESS_MIN_QUESTIONS×2）', () => {
    const counts = [0, 5, 10, 15, 20];
    const values = counts.map(
      (repeatedErrorCount) =>
        scoreCandidate(candidate(), ctx({ gaps: [gap({ repeatedErrorCount })] })).factors.errorRecurrence,
    );
    nonDecreasing(values, 'errorRecurrence');
    expect(values[0]).toBe(0);
    // 20 / (10 × 2) = 1.00
    expect(values[4]).toBe(1);
    expect(WEAKNESS_MIN_QUESTIONS * 2).toBe(20);
  });

  it('timeCost：任务越短越高，且**与预算无关**', () => {
    const estimates = [60, 30, 15, 10, 5];
    const values = estimates.map(
      (estMinutes) => scoreCandidate(candidate({ estMinutes, minMinutes: 5 }), ctx()).factors.timeCost,
    );
    nonDecreasing(values, 'timeCost');
    expect(values[4]).toBe(1);

    // 同一个候选、两个完全不同的预算 → 因子值必须逐字相同
    const wide = scoreCandidate(candidate({ estMinutes: 30 }), ctx({ budgetMinutes: 600 })).factors.timeCost;
    const tight = scoreCandidate(candidate({ estMinutes: 30 }), ctx({ budgetMinutes: 15 })).factors.timeCost;
    expect(wide).toBe(tight);
  });

  it('preferenceFit：偏好越高越高', () => {
    const prefs = [0, 0.25, 0.5, 0.75, 1];
    const values = prefs.map(
      (value) => scoreCandidate(candidate(), ctx({ preferenceByModule: { READING: value } })).factors.preferenceFit,
    );
    nonDecreasing(values, 'preferenceFit');
  });

  it('prerequisiteReady 只有两档（没有中性值）', () => {
    const met = scoreCandidate(candidate(), ctx()).factors.prerequisiteReady;
    const unmet = scoreCandidate(
      candidate({ prerequisites: [{ kind: 'MATERIAL_READY', materialId: 'missing' }] }),
      ctx(),
    ).factors.prerequisiteReady;
    expect(met).toBe(1);
    expect(unmet).toBe(0);
  });
});

// ───────────────────────── ③⑨ P0 不由分数决定 ─────────────────────────

describe('③⑨ P0 是约定，不是分数', () => {
  it('到期的 REVIEW / RETEST 恒 P0，即使其余因子全 0', () => {
    const due = candidate({ sourceKind: 'REVIEW', dueDate: AS_OF });
    const decision = scoreCandidate(
      due,
      ctx({ gaps: [], goal: null, preferenceByModule: {}, minTaskMinutes: 1 }),
    );
    expect(decision.priority).toBe('P0');
    expect(decision.rationale).toContain('P0');
  });

  it('⑨ 高分拓展型候选落 P1，**不会**占到 P0；低分到期复习仍是 P0', () => {
    // 高分：无到期日、缺口严重度 1.0、时间极短、偏好满分 → 因子几乎全满
    const highScore = candidate({
      candidateKey: 'QUESTION:diagnostic:q1:READING',
      sourceKind: 'QUESTION',
      sourceRef: 'diagnostic:q1',
      dueDate: null,
      estMinutes: 3,
      minMinutes: 3,
      meta: { estMinutesSource: 'DERIVED', derivedFrom: 'CANDIDATE_DEFAULT_MINUTES.QUESTION.MCQ' },
    });
    const highCtx = ctx({
      gaps: [gap({ severity: 1, repeatedErrorCount: 20 })],
      preferenceByModule: { READING: 1 },
      // 目标日就定在今天 → goalRelevance 取满，其余因子也全满
      goal: {
        track: 'IELTS_PREPARATION',
        targetValue: '6.5',
        targetDate: AS_OF,
        skillTargets: { READING: 6.5 },
        hasActiveCycle: true,
      },
    });
    const high = scoreCandidate(highScore, highCtx);
    // 非到期候选的天花板是 0.78：`urgency` 结构性为 0（无 dueDate → 确认为无紧迫性），
    // 所以"高分"只能到 0.78 —— 更高就说明有因子越界了
    expect(high.factors.urgency).toBe(0);
    expect(high.score).toBeCloseTo(0.78, 10);
    expect(high.priority).toBe('P1');
    expect(high.priority).not.toBe('P0');

    // 低分：到期复习，其余因子尽量压低 —— 分数落在 P3 区间，但仍然必须是 P0
    const low = scoreCandidate(
      candidate({ sourceKind: 'REVIEW', dueDate: AS_OF, skillGapKey: null }),
      ctx({ gaps: [], goal: null, preferenceByModule: {}, minTaskMinutes: 1 }),
    );
    expect(low.score).toBeLessThan(0.42);
    expect(low.priority).toBe('P0');
  });

  it('到期日早于今天也算 P0；到期日在未来则走分数分层', () => {
    expect(
      priorityOf(0.01, { sourceKind: 'REVIEW', dueDate: addDays(AS_OF, -3) }, AS_OF),
    ).toBe('P0');
    expect(
      priorityOf(0.01, { sourceKind: 'REVIEW', dueDate: addDays(AS_OF, 3) }, AS_OF),
    ).toBe('P3');
    // `PROBE` 落库时映射成 `RETEST`，但它不是"到期复习"，不该无条件占 P0
    expect(priorityOf(0.01, { sourceKind: 'PROBE', dueDate: AS_OF }, AS_OF)).toBe('P3');
  });
});

// ───────────────────────── ④ 阈值边界四连 ─────────────────────────

describe('④ 分层阈值边界', () => {
  it('0.60 → P1、0.59 → P2、0.42 → P2、0.41 → P3', () => {
    const plain = { sourceKind: 'VOCAB' as const, dueDate: null };
    expect(priorityOf(0.6, plain, AS_OF)).toBe('P1');
    expect(priorityOf(0.59, plain, AS_OF)).toBe('P2');
    expect(priorityOf(0.42, plain, AS_OF)).toBe('P2');
    expect(priorityOf(0.41, plain, AS_OF)).toBe('P3');
    expect(PRIORITY_THRESHOLDS).toEqual({ p1: 0.6, p2: 0.42 });
  });

  it('非有限分数不会漏成 P1（NaN 不能"看起来像高分"）', () => {
    expect(priorityOf(Number.NaN, { sourceKind: 'VOCAB', dueDate: null }, AS_OF)).toBe('P3');
  });
});

// ───────────────────────── ⑤⑬ 回落值逐条 ─────────────────────────

describe('⑤⑬ 五个回落值：确认为无 → 0，不知道 → 中性', () => {
  it('前两个严格 === 0，后三个严格 > 0', () => {
    const noSignal = scoreCandidate(
      candidate({ dueDate: null, skillGapKey: null }),
      ctx({ gaps: [], goal: null, preferenceByModule: undefined }),
    );
    expect(noSignal.factors.urgency).toBe(0);
    expect(noSignal.factors.errorRecurrence).toBe(0);
    expect(noSignal.factors.evidenceStrength).toBe(0.3);
    expect(noSignal.factors.evidenceStrength).toBeGreaterThan(0);
    expect(noSignal.factors.goalRelevance).toBe(0.5);
    expect(noSignal.factors.goalRelevance).toBeGreaterThan(0);
    expect(noSignal.factors.preferenceFit).toBe(0.5);
    expect(noSignal.factors.preferenceFit).toBeGreaterThan(0);
  });

  it('⑤ 置信权重表只覆盖 LOW/MEDIUM/HIGH，且 LOW 记 0（T02 保证 LOW 不会进 gaps）', () => {
    expect(Object.keys(PRIORITY_CONFIDENCE_WEIGHT).sort()).toEqual([...EVIDENCE_CONFIDENCES].sort());
    expect(PRIORITY_CONFIDENCE_WEIGHT.HIGH).toBe(1);
    expect(PRIORITY_CONFIDENCE_WEIGHT.MEDIUM).toBe(0.6);
    // 不该出现的输入按"无证据"处理：不编一个 0.3 让它悄悄占分
    expect(PRIORITY_CONFIDENCE_WEIGHT.LOW).toBe(0);
    const low = scoreCandidate(candidate(), ctx({ gaps: [gap({ confidence: 'LOW', severity: 1 })] }));
    expect(low.factors.evidenceStrength).toBe(0);
  });
});

// ───────────────────────── ⑧㉑ goalRelevance 的三个"不知道"分支 ─────────────────────────

describe('⑧㉑ goalRelevance：三个"不知道"分支必须显式回落 0.50', () => {
  it('无 goal → 0.50（显式断言不等于 1.0 也不等于 0）', () => {
    const value = scoreCandidate(candidate(), ctx({ goal: null })).factors.goalRelevance;
    expect(value).toBe(0.5);
    expect(value).not.toBe(1);
    expect(value).not.toBe(0);
  });

  it('有目标但没有在跑的周期 → 0.50（不是 1.00）', () => {
    const value = scoreCandidate(
      candidate(),
      ctx({
        goal: {
          track: 'IELTS_PREPARATION',
          targetValue: '6.5',
          targetDate: addDays(AS_OF, 60),
          skillTargets: { READING: 6.5 },
          hasActiveCycle: false,
        },
      }),
    ).factors.goalRelevance;
    expect(value).toBe(0.5);
  });

  it('有周期但没有目标日 → 0.50（`diffDays(undefined)` 会退化成 0 → 1.00，这是那条陷阱）', () => {
    const value = scoreCandidate(
      candidate(),
      ctx({
        goal: {
          track: 'IELTS_PREPARATION',
          targetValue: null,
          targetDate: null,
          skillTargets: { READING: 6.5 },
          hasActiveCycle: true,
        },
      }),
    ).factors.goalRelevance;
    expect(value).toBe(0.5);
    expect(value).not.toBe(1);
  });

  it('目标日是脏值 → 0.50（`clamp01(NaN)` 是 0，公式会算出 1.00）', () => {
    const value = scoreCandidate(
      candidate(),
      ctx({
        goal: {
          track: 'IELTS_PREPARATION',
          targetValue: '6.5',
          targetDate: 'not-a-date',
          skillTargets: { READING: 6.5 },
          hasActiveCycle: true,
        },
      }),
    ).factors.goalRelevance;
    expect(value).toBe(0.5);
    expect(Number.isFinite(value)).toBe(true);
  });

  it('㉑ 该技能不在目标内 → 0.30（确认为无关系），不是 0、不是 NaN', () => {
    const grammar = candidate({
      candidateKey: 'EGIU:egiu:u1:GRAMMAR',
      sourceKind: 'EGIU',
      sourceRef: 'egiu:u1',
      module: 'GRAMMAR',
      targetSkill: 'GRAMMAR',
      skillGapKey: gapKeyOf('AUXILIARY', 'GRAMMAR', ''),
      estMinutes: 10,
      minMinutes: 10,
      meta: { estMinutesSource: 'DERIVED', derivedFrom: 'EST_MINUTES_BY_INTERVAL.D7' },
    });
    const decision = scoreCandidate(grammar, ctx());
    expect(decision.factors.goalRelevance).toBe(0.3);
    expect(Number.isFinite(decision.factors.goalRelevance)).toBe(true);
  });

  it('㉑ 目标里显式写了 0 分的技能仍算"在目标内"（键存在 ≠ 没设）', () => {
    const value = scoreCandidate(
      candidate(),
      ctx({
        goal: {
          track: 'IELTS_PREPARATION',
          targetValue: '6.5',
          targetDate: addDays(AS_OF, 45),
          skillTargets: { READING: 0 },
          hasActiveCycle: true,
        },
      }),
    ).factors.goalRelevance;
    // 有键 → 走公式：剩余 45 天 → 1 − 45/90 = 0.50
    expect(value).toBe(0.5);
  });
});

// ───────────────────────── ⑩ evidenceStrength 的 0.30 是中性 ─────────────────────────

describe('⑩ evidenceStrength 无缺口回落 0.30（中性偏低，不是打压到 0）', () => {
  it('0.30 落 P2、0 落 P3 —— 差异在阈值边界上可观察', () => {
    // 其余因子固定，只切换 evidenceStrength 的两条来源
    // 其余因子固定：urgency 0.40（今天到期）、goalRelevance 0.50（无目标）、
    // prerequisiteReady 1、timeCost 0.50（10 分钟 / 粒度 5）、preferenceFit 0.50
    // 用 EGIU：它有真实的到期日（复习点），但**不是** REVIEW/RETEST，不会被 P0 短路
    const egui = (over: Partial<TaskCandidateDraft> = {}) =>
      candidate({
        candidateKey: 'EGIU:egiu:u1:GRAMMAR',
        sourceKind: 'EGIU',
        sourceRef: 'egiu:u1',
        module: 'GRAMMAR',
        targetSkill: 'GRAMMAR',
        primarySkill: 'FOUNDATION',
        skillGapKey: gapKeyOf('AUXILIARY', 'GRAMMAR', ''),
        dueDate: AS_OF,
        estMinutes: 10,
        minMinutes: 5,
        meta: { estMinutesSource: 'DERIVED', derivedFrom: 'EST_MINUTES_BY_INTERVAL.D7' },
        ...over,
      });
    const fixed = ctx({ preferenceByModule: { GRAMMAR: 0.5 }, goal: null, minTaskMinutes: 5 });
    const withNeutral = scoreCandidate(egui({ skillGapKey: null }), { ...fixed, gaps: [] });
    // 同一候选但缺口严重度 0（因子得 0）—— 用来模拟"把无缺口当成 0"的实现
    const withZero = scoreCandidate(egui(), {
      ...fixed,
      gaps: [gap({ dimensionKind: 'AUXILIARY', skill: 'GRAMMAR', subskill: '', severity: 0 })],
    });
    expect(withNeutral.factors.evidenceStrength).toBe(0.3);
    expect(withZero.factors.evidenceStrength).toBe(0);
    // 0.368 vs 0.428 —— 只差 0.06，但恰好把他俩放在 0.42 的两侧
    expect(withZero.score).toBeLessThan(0.42);
    expect(withNeutral.score).toBeGreaterThan(0.42);
    expect(withNeutral.priority).toBe('P2');
    expect(withZero.priority).toBe('P3');
  });
});

// ───────────────────────── ⑪⑮ 权重与版本真的参与计算 ─────────────────────────

describe('⑪⑮ 权重/版本/落库值都真的被读', () => {
  const evidenceHeavy: PriorityWeights = {
    urgency: 0.02,
    goalRelevance: 0.18,
    evidenceStrength: 0.4,
    errorRecurrence: 0.12,
    prerequisiteReady: 0.1,
    timeCost: 0.1,
    preferenceFit: 0.08,
  };

  it('⑪ 只改权重与版本 → 至少一条候选的 priority 变化', () => {
    const target = candidate({ dueDate: null, estMinutes: 10, minMinutes: 5 });
    const before = scoreCandidate(target, ctx());
    const after = scoreCandidate(target, ctx({ weights: evidenceHeavy, weightsVersion: 'w2' }));
    // 只换了权重表：证据权重 0.20 → 0.40、紧急度 0.22 → 0.02
    expect(after.score).toBeGreaterThan(before.score);
    expect(before.score).toBeLessThan(0.42);
    expect(after.score).toBeGreaterThan(0.42);
    expect(before.priority).toBe('P3');
    expect(after.priority).toBe('P2');
    expect(before.weightsVersion).toBe('w1');
    expect(after.weightsVersion).toBe('w2');
  });

  it('⑮ evidenceStrength 读落库的 severity，不在评分层重算', () => {
    // 落库 severity=0.40、HIGH → 0.40 × 1.0 = 0.40
    const decision = scoreCandidate(candidate(), ctx({ gaps: [gap({ severity: 0.4, confidence: 'HIGH' })] }));
    expect(decision.factors.evidenceStrength).toBe(0.4);

    // 把"如果重算会得出不同值"的那些输入改成另一组：重算实现会跟着变，读落库值不会
    const recomputeWouldDiffer = scoreCandidate(
      candidate(),
      ctx({
        gaps: [
          gap({
            severity: 0.4,
            confidence: 'HIGH',
            // 这几项是 severity 的输入；改它们只影响"重算"，不影响落库值
            evidenceQuestions: 1,
            repeatedErrorCount: 0,
            coverageRatio: 1,
          }),
        ],
      }),
    );
    expect(recomputeWouldDiffer.factors.evidenceStrength).toBe(0.4);
  });

  it('MEDIUM 置信度的缺口按 0.6 折算（0.40 × 0.6 = 0.24）', () => {
    const decision = scoreCandidate(candidate(), ctx({ gaps: [gap({ severity: 0.4, confidence: 'MEDIUM' })] }));
    expect(decision.factors.evidenceStrength).toBeCloseTo(0.24, 10);
  });
});

// ───────────────────────── ⑥ 前置条件 ─────────────────────────

describe('⑥ 前置条件不满足 → BLOCKED_PREREQUISITE', () => {
  it('因子为 0、eligibility 为 BLOCKED、blockedReason 非空', () => {
    const decision = scoreCandidate(
      candidate({ prerequisites: [{ kind: 'TRANSCRIPT_CONFIRMED', audioAssetId: 'missing' }] }),
      ctx(),
    );
    expect(decision.factors.prerequisiteReady).toBe(0);
    expect(decision.eligibility).toBe('BLOCKED_PREREQUISITE');
    expect(decision.blockedReason).toBeTruthy();
    expect(decision.blockedReason).toContain('TRANSCRIPT_CONFIRMED');
  });

  it('满足时 eligibility 为 ELIGIBLE 且 blockedReason 为 null', () => {
    const decision = scoreCandidate(
      candidate({ prerequisites: [{ kind: 'MATERIAL_READY', materialId: 'm1' }] }),
      ctx(),
    );
    expect(decision.eligibility).toBe('ELIGIBLE');
    expect(decision.blockedReason).toBeNull();
  });

  it('评分层不去判 OVER_BUDGET / DUPLICATE（那是装箱与去重层的事）', () => {
    // 一条 600 分钟的任务，预算只有 60 —— 仍然 ELIGIBLE：它可能被拆到多天，
    // 也可能被顺延。在评分阶段标成"超预算"会让它连被考虑的机会都没有。
    const long = scoreCandidate(candidate({ estMinutes: 600, minMinutes: 30 }), ctx({ budgetMinutes: 60 }));
    expect(long.eligibility).toBe('ELIGIBLE');
  });
});

// ───────────────────────── ⑦ consequenceIfSkipped ─────────────────────────

describe('⑦ 若不做会怎样：可判才写，判不了给 null', () => {
  it('无 dueDate 且无缺口 → null（不编造）', () => {
    const decision = scoreCandidate(candidate({ dueDate: null, skillGapKey: null }), ctx({ gaps: [] }));
    expect(decision.consequenceIfSkipped).toBeNull();
  });

  it('有到期日 → 说清逾期从哪天开始', () => {
    const decision = scoreCandidate(candidate({ dueDate: AS_OF }), ctx());
    expect(decision.consequenceIfSkipped).toContain(AS_OF);
  });

  it('有已证实缺口 → 说清哪个维度不会改善', () => {
    const decision = scoreCandidate(candidate({ dueDate: null }), ctx({ gaps: [gap()] }));
    expect(decision.consequenceIfSkipped).toContain('detail_scanning');
  });
});

// ───────────────────────── ⑭ noObservation ─────────────────────────

describe('⑭ errorRecurrence：未观察 ≠ 确认为无', () => {
  it('evidenceQuestions === 0 → 0.00 且 noObservation=true', () => {
    const decision = scoreCandidate(
      candidate(),
      ctx({ gaps: [gap({ evidenceQuestions: 0, repeatedErrorCount: null })] }),
    );
    expect(decision.factors.errorRecurrence).toBe(0);
    expect(decision.meta.noObservation).toBe(true);
  });

  it('evidenceQuestions > 0 且无重复错误 → 0.00 且 noObservation=false', () => {
    const decision = scoreCandidate(
      candidate(),
      ctx({ gaps: [gap({ evidenceQuestions: 20, repeatedErrorCount: 0 })] }),
    );
    expect(decision.factors.errorRecurrence).toBe(0);
    expect(decision.meta.noObservation).toBe(false);
  });

  it('repeatedErrorCount === null（没统计过）→ 0.00 且 noObservation=true', () => {
    const decision = scoreCandidate(
      candidate(),
      ctx({ gaps: [gap({ evidenceQuestions: 20, repeatedErrorCount: null })] }),
    );
    expect(decision.factors.errorRecurrence).toBe(0);
    expect(decision.meta.noObservation).toBe(true);
  });

  it('候选没有关联缺口 → 0.00 且 noObservation=false（"没有这个维度"不是"没观察过"）', () => {
    const decision = scoreCandidate(candidate({ skillGapKey: null }), ctx({ gaps: [] }));
    expect(decision.factors.errorRecurrence).toBe(0);
    expect(decision.meta.noObservation).toBe(false);
  });
});

// ───────────────────────── ⑭b 无 IO ─────────────────────────

describe('⑭b 评分层无 IO：不 import prisma、不查库', () => {
  const source = readFileSync(new URL('../taskPriority.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('taskPriority.ts', source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  file.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });

  it('模块图里没有 prisma（AST 级，不是文本 grep）', () => {
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((spec) => /prisma/i.test(spec))).toEqual([]);
  });

  it('也没有 `prisma.` 成员访问（有人绕过 import 用全局时抓这条）', () => {
    let hits = 0;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText() === 'prisma') hits += 1;
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(hits).toBe(0);
  });
});

// ───────────────────────── ⑯⑰ factorsJson 形状与有限性 ─────────────────────────

describe('⑯⑰ factorsJson：meta 分层、score 有限', () => {
  it('factors 恰好 7 个键，键集与 DEFAULT_WEIGHTS **完全相等**', () => {
    const decision = scoreCandidate(candidate(), ctx());
    expect(Object.keys(decision.factors).length).toBe(7);
    expect(Object.keys(decision.factors).sort()).toEqual(Object.keys(DEFAULT_WEIGHTS).sort());
  });

  it('toFactorsJson 顶层只有 factors / meta 两层（平铺会让 score 变 NaN）', () => {
    const decision = scoreCandidate(candidate(), ctx());
    const json = toFactorsJson(decision);
    expect(Object.keys(json).sort()).toEqual(['factors', 'meta']);
    expect(Object.keys(json.factors).length).toBe(7);
    // 审计字段在 meta 里，不在 factors 里
    expect('noObservation' in json.factors).toBe(false);
    expect('estMinutesSource' in json.factors).toBe(false);
    expect(json.meta.estMinutesSource).toBe('SOURCE');
  });

  it('派生分钟的出处随 meta 落库（解释面板要有依据）', () => {
    const derived = scoreCandidate(
      candidate({ meta: { estMinutesSource: 'DERIVED', derivedFrom: 'CANDIDATE_DEFAULT_MINUTES.QUESTION.MCQ' } }),
      ctx(),
    );
    const json = toFactorsJson(derived);
    expect(json.meta.estMinutesSource).toBe('DERIVED');
    expect(json.meta.derivedFrom).toBe('CANDIDATE_DEFAULT_MINUTES.QUESTION.MCQ');
  });

  it('score 是 0..1 的有限数', () => {
    const decision = scoreCandidate(candidate(), ctx());
    expect(Number.isFinite(decision.score)).toBe(true);
    expect(decision.score).toBeGreaterThanOrEqual(0);
    expect(decision.score).toBeLessThanOrEqual(1);
  });

  it('⑰ 求和遍历权重表：factors 里被塞多余键也不影响 score', () => {
    const decision = scoreCandidate(candidate(), ctx());
    const dirty = { ...decision.factors, noObservation: 1, _meta: 1 } as FactorTrace;
    expect(weightedScore(dirty, DEFAULT_WEIGHTS)).toBe(decision.score);
    expect(Number.isFinite(weightedScore(dirty, DEFAULT_WEIGHTS))).toBe(true);
  });

  it('⑰ 权重含 NaN 时直接抛，不产出 NaN 分数', () => {
    const broken = { ...DEFAULT_WEIGHTS, urgency: Number.NaN };
    expect(() => weightedScore(scoreCandidate(candidate(), ctx()).factors, broken)).toThrow(/有限数/);
  });
});

// ───────────────────────── ⑱ noObservation 进 hash、不进版本 ─────────────────────────

describe('⑱ noObservation 随 gaps 进 inputHash，但不改 weightsVersion', () => {
  it('只改 evidenceQuestions（0 ↔ 20）→ hash 变、版本不变', async () => {
    const { hashPlanningInput } = await import('@/lib/domain/planningSnapshot');
    const base = {
      weightsVersion: WEIGHTS_VERSION,
      config: { minTaskMinutes: 5, bufferRatio: 0.1 },
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 7,
      stage: { code: 'S3_B1_IELTS', profileCode: 'B1_B2' },
      budget: { minutes: 60, tierCode: 'STANDARD', isRestDay: false, isInitialSuggestion: false },
      dueReviews: [],
      candidates: [],
    };
    const notObserved = { ...base, gaps: [gap({ evidenceQuestions: 0, repeatedErrorCount: null })] };
    const observed = { ...base, gaps: [gap({ evidenceQuestions: 20, repeatedErrorCount: 4 })] };
    expect(hashPlanningInput(notObserved)).not.toBe(hashPlanningInput(observed));

    const before = scoreCandidate(candidate(), ctx({ gaps: notObserved.gaps }));
    const after = scoreCandidate(candidate(), ctx({ gaps: observed.gaps }));
    expect(before.weightsVersion).toBe(after.weightsVersion);
    expect(before.meta.noObservation).toBe(true);
    expect(after.meta.noObservation).toBe(false);
  });
});

// ───────────────────────── ⑫ G-10 权重 schema ─────────────────────────

describe('⑫ priorityWeightsSchema：四项非法输入都必须 VALIDATION，且不回落默认值', () => {
  it('合法权重通过并原样返回', () => {
    const result = validatePriorityWeights(DEFAULT_PRIORITY_WEIGHTS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(DEFAULT_PRIORITY_WEIGHTS);
  });

  const cases: { name: string; input: unknown; keyword: string }[] = [
    {
      name: 'Σ ≠ 1（0.90）',
      input: { ...DEFAULT_PRIORITY_WEIGHTS, urgency: 0.12 },
      keyword: '之和必须等于 1',
    },
    {
      name: '含负数',
      input: { ...DEFAULT_PRIORITY_WEIGHTS, urgency: -0.22, preferenceFit: 0.52 },
      keyword: '不能为负',
    },
    {
      name: '含未知键',
      input: { ...DEFAULT_PRIORITY_WEIGHTS, bogus: 0.05 },
      keyword: '',
    },
    {
      name: '缺键',
      input: { urgency: 0.22, goalRelevance: 0.18, evidenceStrength: 0.2, errorRecurrence: 0.12, prerequisiteReady: 0.1, timeCost: 0.1 },
      keyword: '',
    },
  ];

  it('四项非法输入都返回 VALIDATION，且**不**回落默认值', () => {
    for (const item of cases) {
      const result = validatePriorityWeights(item.input);
      expect(result.ok, item.name).toBe(false);
      if (!result.ok) {
        expect(result.code, item.name).toBe('VALIDATION');
        // 不回落默认值：返回值里不该出现一份"看起来对"的权重
        expect('data' in result, item.name).toBe(false);
      }
    }
  });

  it('阈值 p1 <= p2 被拒', async () => {
    const { priorityThresholdsSchema } = await import('@/lib/schema/planner');
    expect(priorityThresholdsSchema.safeParse({ p1: 0.42, p2: 0.6 }).success).toBe(false);
    expect(priorityThresholdsSchema.safeParse({ p1: 0.6, p2: 0.6 }).success).toBe(false);
    expect(priorityThresholdsSchema.safeParse({ p1: 0.6, p2: 0.42 }).success).toBe(true);
  });
});

// ───────────────────────── 常量自洽 ─────────────────────────

describe('常量自洽：中性值与额度分档', () => {
  it('中性值就是文档写的 0.50；无缺口证据强度就是文档写的 0.30', () => {
    expect(PRIORITY_NEUTRAL_VALUE).toBe(0.5);
    const noGap = scoreCandidate(candidate({ skillGapKey: null }), ctx({ gaps: [] }));
    expect(noGap.factors.evidenceStrength).toBe(0.3);
  });

  it('派生分钟能落进 meta（与 T03 的采集层同源）', () => {
    expect(CANDIDATE_DEFAULT_MINUTES.PROBE).toBe(10);
    const probe = scoreCandidate(
      candidate({
        sourceKind: 'PROBE',
        sourceRef: 'probe:READING|detail_scanning',
        dueDate: null,
        estMinutes: CANDIDATE_DEFAULT_MINUTES.PROBE,
        minMinutes: CANDIDATE_DEFAULT_MINUTES.PROBE,
        meta: { estMinutesSource: 'DERIVED', derivedFrom: 'CANDIDATE_DEFAULT_MINUTES.PROBE' },
      }),
      ctx(),
    );
    expect(probe.meta.estMinutesSource).toBe('DERIVED');
    expect(probe.priority).not.toBe('P0');
  });
});

// ───────────────────────── ㉓ 排序键 ─────────────────────────

describe('㉓ 排序键：priority 升序 → score 降序 → candidateKey 升序', () => {
  const decision = (over: Partial<TaskPriorityDecisionDraft>): TaskPriorityDecisionDraft => ({
    candidateKey: 'REVIEW:review:r1:READING',
    weightsVersion: WEIGHTS_VERSION,
    factors: { ...DEFAULT_WEIGHTS },
    score: 0.5,
    priority: 'P2',
    rationale: '测试',
    consequenceIfSkipped: null,
    eligibility: 'ELIGIBLE',
    blockedReason: null,
    meta: { estMinutesSource: 'SOURCE', skillGapKey: null, evidenceRefs: [], noObservation: false },
    ...over,
  });

  it('① 同 priority 同 score → 按 candidateKey 升序，且与输入顺序无关', () => {
    const a = decision({ candidateKey: 'QUESTION:diagnostic:a:READING' });
    const b = decision({ candidateKey: 'QUESTION:diagnostic:b:READING' });
    // 两条完全相同（同分层、同分），唯一能决出顺序的就是末位键
    const forward = orderDecisions([b, a]).map((row) => row.candidateKey);
    const backward = orderDecisions([a, b]).map((row) => row.candidateKey);
    expect(forward).toEqual(['QUESTION:diagnostic:a:READING', 'QUESTION:diagnostic:b:READING']);
    // 打乱输入两次 → 输出逐字相同（证明末位键生效，而不是靠数组/DB 顺序）
    expect(forward).toEqual(backward);
  });

  it('② priority 必须排在 score 之前：高分 P3 不能排到低分 P0 前面', () => {
    const highScoreP3 = decision({ candidateKey: 'EXTENDED:x:READING', priority: 'P3', score: 0.99 });
    const lowScoreP0 = decision({ candidateKey: 'REVIEW:review:r1:READING', priority: 'P0', score: 0.1 });
    const ordered = orderDecisions([highScoreP3, lowScoreP0]);
    expect(ordered[0]?.priority).toBe('P0');
    expect(ordered[1]?.priority).toBe('P3');
    // 写成 `score desc → priority` 时这一条会红 —— 而它在页面上只表现为"顺序不同"
  });

  it('同分层内按 score 降序', () => {
    const low = decision({ candidateKey: 'QUESTION:diagnostic:z:READING', score: 0.45 });
    const high = decision({ candidateKey: 'QUESTION:diagnostic:y:READING', score: 0.55 });
    expect(orderDecisions([low, high]).map((row) => row.candidateKey)).toEqual([
      'QUESTION:diagnostic:y:READING',
      'QUESTION:diagnostic:z:READING',
    ]);
  });

  it('排序是纯函数：不改入参顺序', () => {
    const list = [
      decision({ candidateKey: 'QUESTION:diagnostic:b:READING', priority: 'P3', score: 0.1 }),
      decision({ candidateKey: 'QUESTION:diagnostic:a:READING', priority: 'P0', score: 0.9 }),
    ];
    const before = list.map((row) => row.candidateKey);
    orderDecisions(list);
    expect(list.map((row) => row.candidateKey)).toEqual(before);
  });
});
