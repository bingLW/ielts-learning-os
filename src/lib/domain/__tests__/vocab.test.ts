/**
 * 被测文件：src/lib/domain/vocab.ts（quizAccuracy / suggestNewWordCount / masteryDistribution）
 * 规则来源：PRD §5.7（三档掌握度不可合并、抽测 50–100 词输出加权正确率）
 *           + PRD §6.6（词汇正确率加权：主动用 1.0 / 能理解 0.7 / 认识但不能用 0.3）
 *           + PRD Q4（<80% 下调为 12；≥90% 上调、上限 25；默认 18）。
 */

import { describe, expect, it } from 'vitest';
import {
  defaultNewWordCount,
  masteryDistribution,
  quizAccuracy,
  suggestNewWordCount,
} from '../vocab';
import {
  MASTERY_WEIGHT,
  VOCAB_ACC_DOWN_THRESHOLD,
  VOCAB_ACC_UP_THRESHOLD,
  VOCAB_NEW_DEFAULT,
  VOCAB_NEW_DOWN,
  VOCAB_NEW_MAX,
  VOCAB_NEW_MIN,
  VOCAB_NEW_STEP,
  VOCAB_NEW_UP,
} from '../../constants';
import type { MasteryLevel } from '../../types';

const REPEAT = (level: MasteryLevel, count: number): MasteryLevel[] =>
  Array.from({ length: count }, () => level);

describe('三档权重常量（PRD §6.6）', () => {
  it('主动用 1.0 / 能理解 0.7 / 认识但不能用 0.3', () => {
    expect(MASTERY_WEIGHT.ACTIVE_USE, '能主动使用 = 1.0').toBe(1);
    expect(MASTERY_WEIGHT.COMPREHEND, '能理解 = 0.7').toBe(0.7);
    expect(MASTERY_WEIGHT.RECOGNIZE_ONLY, '认识但不能用 = 0.3').toBe(0.3);
  });

  it('新词量常量与 Q4 一致', () => {
    expect(VOCAB_NEW_DEFAULT, '默认 18 个/天').toBe(18);
    expect(VOCAB_NEW_MIN, '下限 15').toBe(15);
    expect(VOCAB_NEW_MAX, '上限 25').toBe(25);
    expect(VOCAB_NEW_DOWN, '<80% 时下调为 12').toBe(12);
    expect(VOCAB_NEW_UP, '≥90% 时至少到 22').toBe(22);
    expect(VOCAB_ACC_DOWN_THRESHOLD, '下调阈值 80%').toBe(0.8);
    expect(VOCAB_ACC_UP_THRESHOLD, '上调阈值 90%').toBe(0.9);
    expect(VOCAB_NEW_STEP, '上调步长 4').toBe(4);
  });
});

describe('quizAccuracy —— 加权正确率', () => {
  it('全部能主动使用 → 1.0', () => {
    expect(quizAccuracy(REPEAT('ACTIVE_USE', 10)), '10 个全 1.0').toBe(1);
  });

  it('全部「认识但不能用」→ 0.3（既不是 1 也不是 0）', () => {
    const result = quizAccuracy(REPEAT('RECOGNIZE_ONLY', 10));
    expect(result as number, '认识 ≠ 掌握：加权正确率只能是 30%').toBeCloseTo(0.3, 5);
    expect(result as number, '不能因为「10 个都认识」就当成 100%').not.toBeCloseTo(1, 5);
    expect(result as number, '也不能当成 0%').not.toBeCloseTo(0, 5);
  });

  it('三档各 1 个 → (1.0 + 0.7 + 0.3) / 3 ≈ 0.6667', () => {
    expect(
      quizAccuracy(['ACTIVE_USE', 'COMPREHEND', 'RECOGNIZE_ONLY']),
      'Σ权重 / 词数',
    ).toBeCloseTo(2 / 3, 5);
  });

  it('加权口径 ≠ 「能理解以上才算对」的条目数口径', () => {
    const result = quizAccuracy(['ACTIVE_USE', 'RECOGNIZE_ONLY']) as number;
    expect(result, '(1.0 + 0.3) / 2 = 0.65').toBeCloseTo(0.65, 5);
    expect(result, '若按条目数算「1 对 1 错」会得 0.5，口径必须不同').not.toBeCloseTo(0.5, 5);
  });

  it('样本量大时分母仍按词数（不是按档位数）', () => {
    expect(
      quizAccuracy([...REPEAT('ACTIVE_USE', 48), ...REPEAT('RECOGNIZE_ONLY', 48)]),
      '(48×1.0 + 48×0.3) / 96 = 0.65',
    ).toBeCloseTo(0.65, 5);
  });

  it('空抽测 → null（不是 0）', () => {
    const result = quizAccuracy([]);
    expect(result, '没有抽测样本必须返回 null').toBeNull();
    expect(result, 'null 绝不能用 0 冒充（0 会被读成「全错」）').not.toBe(0);
  });
});

describe('suggestNewWordCount —— 下周新词量建议', () => {
  it('无抽测数据 → 维持当前值（并夹在 15–25）', () => {
    const keep = suggestNewWordCount(null, 18);
    expect(keep.next, '无数据不下调也不上调').toBe(18);
    expect(keep.reason.includes('暂无抽测数据'), '必须说明为什么没调整').toBe(true);

    expect(suggestNewWordCount(null, 30).next, '当前值超上限 → 夹到 25').toBe(25);
    expect(suggestNewWordCount(null, 10).next, '当前值低于下限 → 提到 15').toBe(15);
  });

  it('上周 <80% → 下调为 12，与当前值无关', () => {
    const low = suggestNewWordCount(0.72, 25);
    expect(low.next, '79% 以下一律降为 12').toBe(12);
    expect(low.reason.includes('下调'), '文案要说清楚是下调').toBe(true);
  });

  it('80% 边界：恰好 80% 不下调', () => {
    expect(
      suggestNewWordCount(VOCAB_ACC_DOWN_THRESHOLD, 18).next,
      '阈值是 <80%，80% 整不触发下调',
    ).toBe(18);
  });

  it('80%–89% 之间 → 维持当前值', () => {
    expect(suggestNewWordCount(0.85, 18).next, '中间区间保持').toBe(18);
  });

  it('≥90% → 至少 22，且按 +4 步长、上限 25', () => {
    expect(suggestNewWordCount(0.9, 18).next, '90% 整即上调：max(22, 18+4) = 22').toBe(22);
    expect(suggestNewWordCount(0.95, 20).next, '20 + 4 = 24').toBe(24);
    expect(suggestNewWordCount(0.95, 24).next, '24 + 4 封顶 25').toBe(25);
    expect(suggestNewWordCount(1, 10).next, '当前值偏低时仍至少到 22').toBe(22);
  });
});

describe('masteryDistribution —— 三档分列，禁止合并', () => {
  it('三档各自计数并给出 total', () => {
    const dist = masteryDistribution([
      { mastery: 'RECOGNIZE_ONLY' },
      { mastery: 'COMPREHEND' },
      { mastery: 'COMPREHEND' },
      { mastery: 'ACTIVE_USE' },
    ]);
    expect(dist, '三档 + total，不得只给一个「已掌握」数').toEqual({
      RECOGNIZE_ONLY: 1,
      COMPREHEND: 2,
      ACTIVE_USE: 1,
      total: 4,
    });
  });

  it('没有词时全为 0，不抛错', () => {
    expect(masteryDistribution([])).toEqual({
      RECOGNIZE_ONLY: 0,
      COMPREHEND: 0,
      ACTIVE_USE: 0,
      total: 0,
    });
  });

  it('默认新词量 = 18', () => {
    expect(defaultNewWordCount(), 'PRD Q4：默认 18').toBe(VOCAB_NEW_DEFAULT);
  });
});
