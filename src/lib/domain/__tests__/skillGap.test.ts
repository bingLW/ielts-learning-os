/**
 * 技能缺口判定（S1–S7，T02）。
 *
 * 这个文件守的是「不确定不能当确定用」：
 * - S2 必须**先于** S3（低置信度 + 20 条样本 → 仍然 UNCERTAINTY）；
 * - S1 必须**先于** S2（没有基线是"不知道"，不是"不确定"）；
 * - S5 **只降级不升格**（HIGH 过期仍是 GAP，MEDIUM 过期才是 UNCERTAINTY）。
 *
 * 顺序错了不会报错，只会让系统开始给用户排他没弱到那个程度的专项训练。
 */

import { describe, expect, it } from 'vitest';
import {
  GAP_MIN_SEVERITY,
  computeGapSeverity,
  splitGapsAndUncertainty,
  type SkillGapSignal,
} from '../skillGap';
import { PROFILE_REVIEW_DAYS, WEAKNESS_MIN_QUESTIONS } from '../../constants';

/** 一个"证据充分、确实弱"的基线信号（会判成 GAP）。 */
function signal(over: Partial<SkillGapSignal> = {}): SkillGapSignal {
  return {
    dimensionKind: 'OFFICIAL',
    skill: 'READING',
    subskill: 'detail_scanning',
    profileConfidence: 'HIGH',
    independentCount: 12,
    evidenceCount: 20,
    evidenceQuestions: 20,
    freshnessDays: 5,
    coverageRatio: 0.4,
    accuracyDelta: 0.2,
    repeatedErrorCount: 8,
    evidenceIds: ['ev-1', 'ev-2'],
    ...over,
  };
}

describe('S1：无 A0 无辅助基线 → UNKNOWN', () => {
  it('independentCount === 0 时即使置信度 LOW 也判 UNKNOWN（S1 先于 S2）', () => {
    const result = splitGapsAndUncertainty([
      signal({ independentCount: 0, profileConfidence: 'LOW' }),
    ]);
    expect(result.unknowns).toHaveLength(1);
    expect(result.unknowns[0].kind).toBe('UNKNOWN');
    expect(result.uncertainties, 'S1 命中后不再走 S2').toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
    expect(result.unknowns[0].reason).toContain('不假定你是 0 分');
    expect(result.unknowns[0].severity, 'UNKNOWN 的严重度恒 0').toBe(0);
  });
});

describe('S2：置信度低 → UNCERTAINTY（样本再多也一样，AC-6）', () => {
  it('confidence=LOW + evidenceQuestions=20 → UNCERTAINTY 且不在 gaps 里', () => {
    const result = splitGapsAndUncertainty([
      signal({ profileConfidence: 'LOW', evidenceQuestions: 20, independentCount: 12 }),
    ]);
    expect(result.gaps, 'AC-6：低置信度不得进 ranked').toHaveLength(0);
    expect(result.uncertainties).toHaveLength(1);
    expect(result.uncertainties[0].kind).toBe('UNCERTAINTY');
    expect(result.uncertainties[0].severity).toBe(0);
  });
});

describe('S3：样本不足 → UNCERTAINTY', () => {
  it('evidenceQuestions=9（< 10）→ UNCERTAINTY，且 reason 写清差几条', () => {
    const result = splitGapsAndUncertainty([
      signal({ evidenceQuestions: WEAKNESS_MIN_QUESTIONS - 1 }),
    ]);
    expect(result.gaps).toHaveLength(0);
    expect(result.uncertainties[0].kind).toBe('UNCERTAINTY');
    expect(result.uncertainties[0].reason).toContain(`9/${WEAKNESS_MIN_QUESTIONS}`);
    expect(result.uncertainties[0].reason).toContain('还差 1 条');
  });
});

describe('S4：没有证据时间戳 → UNKNOWN', () => {
  it('freshnessDays === null → UNKNOWN（不是 UNCERTAINTY）', () => {
    const result = splitGapsAndUncertainty([signal({ freshnessDays: null })]);
    expect(result.unknowns[0].kind).toBe('UNKNOWN');
    expect(result.unknowns[0].stale, '没有时间戳时 stale 为 false（无从判断新旧）').toBe(false);
  });
});

describe('S5：画像过期——只降级不升格', () => {
  it('confidence=HIGH + freshnessDays=200 → 仍是 GAP，但 DTO stale=true', () => {
    const result = splitGapsAndUncertainty([
      signal({ profileConfidence: 'HIGH', freshnessDays: 200 }),
    ]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].kind).toBe('GAP');
    expect(result.gaps[0].stale).toBe(true);
    expect(result.gaps[0].reason).toContain('画像已过期');
  });

  it('confidence=MEDIUM + freshnessDays=200 → UNCERTAINTY', () => {
    const result = splitGapsAndUncertainty([
      signal({ profileConfidence: 'MEDIUM', freshnessDays: 200 }),
    ]);
    expect(result.gaps).toHaveLength(0);
    expect(result.uncertainties[0].kind).toBe('UNCERTAINTY');
    expect(result.uncertainties[0].reason).toContain(
      String(PROFILE_REVIEW_DAYS.MEDIUM),
    );
  });

  it('没过期时 stale 恒为 false', () => {
    const result = splitGapsAndUncertainty([
      signal({ profileConfidence: 'HIGH', freshnessDays: PROFILE_REVIEW_DAYS.HIGH }),
    ]);
    expect(result.gaps[0].stale, '等于阈值不算过期（严格大于才算）').toBe(false);
  });
});

describe('S6 / S7：严重度下限', () => {
  it('严重度不足 → 不发射，记入 suppressed 并说明原因', () => {
    const result = splitGapsAndUncertainty([
      signal({ accuracyDelta: 0, coverageRatio: 1, repeatedErrorCount: 0, freshnessDays: 0 }),
    ]);
    expect(result.gaps).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].why).toContain('低于下限');
  });

  it('严重度够高 → GAP，且 reason 把四个输入都写出来（可解释）', () => {
    const result = splitGapsAndUncertainty([signal()]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].kind).toBe('GAP');
    expect(result.gaps[0].severity).toBeGreaterThanOrEqual(GAP_MIN_SEVERITY);
    expect(result.gaps[0].reason).toContain('证据 20 条');
    expect(result.gaps[0].reason).toContain('覆盖 40%');
    expect(result.gaps[0].reason).toContain('重复错误 8 次');
    expect(result.gaps[0].evidenceIds).toEqual(['ev-1', 'ev-2']);
  });

  it('minSeverity 可覆盖（默认 0.15）', () => {
    expect(GAP_MIN_SEVERITY).toBe(0.15);
    const result = splitGapsAndUncertainty([signal()], { minSeverity: 0.99 });
    expect(result.gaps).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
  });
});

describe('severity 公式（§2.2.1）', () => {
  it('覆盖未知按 0.5 记（既不奖励也不惩罚），不是按 0', () => {
    const known = computeGapSeverity(signal({ coverageRatio: 0 }));
    const unknown = computeGapSeverity(signal({ coverageRatio: null }));
    expect(unknown).toBeLessThan(known);
    expect(unknown).toBeGreaterThan(computeGapSeverity(signal({ coverageRatio: 1 })));
  });

  it('四项都在 0..1，结果不会越界', () => {
    const extreme = computeGapSeverity(
      signal({ accuracyDelta: 99, coverageRatio: -5, repeatedErrorCount: 9999, freshnessDays: 9999 }),
    );
    expect(extreme).toBeLessThanOrEqual(1);
    expect(extreme).toBeGreaterThanOrEqual(0);
  });
});

describe('dimensionKind 分流', () => {
  it('AUXILIARY（GRAMMAR）也能产出缺口，但不带任何配比语义', () => {
    const result = splitGapsAndUncertainty([
      signal({
        dimensionKind: 'AUXILIARY',
        skill: 'GRAMMAR',
        subskill: 'articles',
        accuracyDelta: 0.3,
      }),
    ]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].dimensionKind).toBe('AUXILIARY');
    expect(result.gaps[0].skill).toBe('GRAMMAR');
    // 结果里没有任何"占比/分钟"字段 —— 辅助维度结构上不可能进四项分母
    expect(Object.keys(result.gaps[0])).not.toContain('allocatedMinutes');
    expect(Object.keys(result.gaps[0])).not.toContain('ratio');
  });

  it('同一批里 OFFICIAL 与 AUXILIARY 各自独立裁决，互不影响', () => {
    const result = splitGapsAndUncertainty([
      signal({ dimensionKind: 'OFFICIAL', skill: 'LISTENING', subskill: '' }),
      signal({
        dimensionKind: 'AUXILIARY',
        skill: 'VOCABULARY',
        subskill: 'collocation',
        profileConfidence: 'LOW',
      }),
    ]);
    expect(result.gaps.filter((row) => row.dimensionKind === 'OFFICIAL')).toHaveLength(1);
    expect(result.uncertainties.filter((row) => row.dimensionKind === 'AUXILIARY')).toHaveLength(1);
  });
});

describe('missingEvidence：来自 suggestProfileConfidence，不在这里重判', () => {
  it('信号带了 missingEvidence → 原样进 DTO（供 SkillGap.missingEvidenceJson 落库）', () => {
    const result = splitGapsAndUncertainty([
      signal({ profileConfidence: 'LOW', missingEvidence: ['缺 1 次限时阅读', '缺无辅助口语样本'] }),
    ]);
    expect(result.uncertainties[0].missingEvidence).toEqual([
      '缺 1 次限时阅读',
      '缺无辅助口语样本',
    ]);
  });

  it('没传时是空数组而不是 undefined（落库端不用再判空）', () => {
    const result = splitGapsAndUncertainty([signal()]);
    expect(result.gaps[0].missingEvidence).toEqual([]);
  });
});
