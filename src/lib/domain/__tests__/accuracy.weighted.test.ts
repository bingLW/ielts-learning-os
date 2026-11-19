/**
 * 被测文件：src/lib/domain/accuracy.ts
 * 规则来源：PRD §6.6（平均正确率 = Σcorrect / Σtotal 加权；严禁对 accuracy 数组取算术平均；
 *           total=0 / null 的样本直接剔除、不当 0；全部剔除 → null 而不是 0）。
 *
 * 与 aggregate.test.ts 的分工：那边只验「一个正例 + 空数组」，这里把「不能取平均」
 * 这条最容易写错的规则单独钉死，并覆盖 mergeSampleTotals 的分子分母合并。
 */

import { describe, expect, it } from 'vitest';
import {
  accuracyGap,
  accuracyOf,
  isCountableSample,
  mergeSampleTotals,
  weightedAccuracy,
} from '../accuracy';
import type { AccSample } from '../../types';

/** 需求里的三样本：9/10、0/0、1/2。 */
const SAMPLES: AccSample[] = [
  { total: 10, correct: 9 },
  { total: 0, correct: 0 },
  { total: 2, correct: 1 },
];

describe('weightedAccuracy —— 先合并分子分母再相除', () => {
  it('9/10 + 0/0 + 1/2 → 10/12 ≈ 0.8333', () => {
    const result = weightedAccuracy(SAMPLES);
    expect(result, '加权正确率不应为 null').not.toBeNull();
    expect(result as number, 'Σcorrect=10、Σtotal=12 → 0.8333').toBeCloseTo(10 / 12, 5);
  });

  it('必须不等于「各次正确率的算术平均」', () => {
    const result = weightedAccuracy(SAMPLES) as number;
    const naiveMean = (0.9 + 0 + 0.5) / 3;
    expect(
      result,
      'PRD §6.6：严禁对 accuracy 取算术平均。若这里相等，说明实现退化成了平均值',
    ).not.toBeCloseTo(naiveMean, 3);
    expect(naiveMean, '算术平均为 0.4667，与加权 0.8333 明显不同').toBeCloseTo(0.4667, 3);
  });

  it('样本量悬殊时加权结果偏向大题量样本', () => {
    expect(
      weightedAccuracy([
        { total: 90, correct: 90 },
        { total: 10, correct: 0 },
      ]),
      '90 题全对 + 10 题全错 → 0.9，而不是 0.5',
    ).toBeCloseTo(0.9, 5);
  });

  it('total=0 的样本被剔除，不拉低结果', () => {
    expect(
      weightedAccuracy([
        { total: 10, correct: 9 },
        { total: 0, correct: 0 },
      ]),
      '0 题样本不参与统计',
    ).toBeCloseTo(0.9, 5);
  });

  it('全部样本 total=0 → null（不是 0）', () => {
    const result = weightedAccuracy([
      { total: 0, correct: 0 },
      { total: 0, correct: 0 },
    ]);
    expect(result, '无有效样本必须返回 null').toBeNull();
    expect(result, '无有效样本绝不能返回 0（0 会被读成「全错」）').not.toBe(0);
  });

  it('total 为 null 的样本同样剔除', () => {
    expect(weightedAccuracy([{ total: null, correct: null }]), 'null 样本不算 0').toBeNull();
    expect(
      weightedAccuracy([
        { total: null, correct: null },
        { total: 4, correct: 3 },
      ]),
      '只有 3/4 一个有效样本',
    ).toBeCloseTo(0.75, 5);
  });

  it('correct > total 被夹到 total（脏数据不制造 >1 的正确率）', () => {
    expect(
      weightedAccuracy([{ total: 4, correct: 9 }]),
      'correct 超过 total 时按 total 计，结果封顶 1',
    ).toBeCloseTo(1, 5);
  });

  it('correct 为负数被夹到 0', () => {
    expect(weightedAccuracy([{ total: 4, correct: -2 }]), '负数正确题按 0 计').toBeCloseTo(0, 5);
  });

  it('correct 为 null 时按 0 计（题量有效、答对未知）', () => {
    expect(weightedAccuracy([{ total: 4, correct: null }]), '未知对错按 0').toBeCloseTo(0, 5);
  });

  it('空数组 → null', () => {
    expect(weightedAccuracy([])).toBeNull();
  });
});

describe('mergeSampleTotals —— 分子分母同时给出', () => {
  it('合并后 10/12，accuracy 与 weightedAccuracy 一致', () => {
    const merged = mergeSampleTotals(SAMPLES);
    expect(merged.correct, 'Σcorrect = 9 + 1 = 10').toBe(10);
    expect(merged.total, 'Σtotal = 10 + 2 = 12（0 题样本被剔除）').toBe(12);
    expect(merged.accuracy as number, 'accuracy = 10/12').toBeCloseTo(10 / 12, 5);
    expect(merged.accuracy, '两条口径必须完全一致').toBe(weightedAccuracy(SAMPLES));
  });

  it('无有效样本 → {0,0,null}', () => {
    expect(mergeSampleTotals([{ total: 0, correct: 0 }]), '分子分母为 0 时 accuracy 必须是 null').toEqual(
      { correct: 0, total: 0, accuracy: null },
    );
  });
});

describe('accuracyOf —— 单次正确率', () => {
  it('正常值', () => {
    expect(accuracyOf(9, 10), '9/10').toBeCloseTo(0.9, 5);
  });

  it('total 为 0 或负 → null', () => {
    expect(accuracyOf(0, 0), '0/0 不是 0%').toBeNull();
    expect(accuracyOf(5, 0), '分母 0 无意义').toBeNull();
    expect(accuracyOf(5, -3), '负分母非法').toBeNull();
  });

  it('total 为 null / undefined → null', () => {
    expect(accuracyOf(5, null)).toBeNull();
    expect(accuracyOf(5, undefined)).toBeNull();
  });

  it('correct 为 null / undefined → null（有题量但没填对错）', () => {
    expect(accuracyOf(null, 10)).toBeNull();
    expect(accuracyOf(undefined, 10)).toBeNull();
  });

  it('correct 越界被夹紧', () => {
    expect(accuracyOf(20, 10), '对题数超过题量时封顶 1').toBeCloseTo(1, 5);
    expect(accuracyOf(-3, 10), '负对题数按 0').toBeCloseTo(0, 5);
  });
});

describe('isCountableSample —— 是否参与统计', () => {
  it('只有 total > 0 才计入', () => {
    expect(isCountableSample({ total: 10, correct: 9 })).toBe(true);
    expect(isCountableSample({ total: 1, correct: 0 }), '1 题也是有效样本').toBe(true);
    expect(isCountableSample({ total: 0, correct: 0 })).toBe(false);
    expect(isCountableSample({ total: -1, correct: 0 })).toBe(false);
    expect(isCountableSample({ total: null, correct: 0 })).toBe(false);
  });
});

describe('accuracyGap —— 科目与维度之差', () => {
  it('差值夹在 0..1，任一为 null 时返回 0', () => {
    expect(accuracyGap(0.9, 0.7), '0.9 - 0.7 = 0.2').toBeCloseTo(0.2, 5);
    expect(accuracyGap(0.7, 0.9), '负数缺口夹到 0（不制造虚假薄弱）').toBe(0);
    expect(accuracyGap(null, 0.5), '无科目正确率 → 0').toBe(0);
    expect(accuracyGap(0.9, null), '无维度正确率 → 0').toBe(0);
    expect(accuracyGap(null, null)).toBe(0);
  });
});
