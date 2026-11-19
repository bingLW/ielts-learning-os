/**
 * 被测文件：src/lib/domain/allocation.ts
 * 规则来源：SOP v2 §2（四技能配比只以四项专项训练为分母）、
 *           需求 §11.1（配比合计 ≠ 100% 拒绝保存；支持时间不进分母）。
 *
 * 本文件覆盖 P1 验收重点：
 *   ① 三档内置配比数值与总和；
 *   ② 配比校验（合计≠100 拒存、单项越界拒存、负数/NaN 拒存）；
 *   ③ 分母隔离（FOUNDATION 不进分母）；
 *   ④ 分母为 0 时占比为 null 而非 0；
 *   ⑤ splitByAllocation 的 Σ === totalMinutes。
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_RAISE_MAX,
  ALLOCATION_RAISE_MIN,
  accumulatePrimaryMinutes,
  allocationDeviation,
  allocationTotal,
  checkAllocation,
  defaultAllocationFor,
  emptyPrimaryMinutes,
  skillShare,
  splitByAllocation,
  suggestRaise,
  shouldRaiseAllocation,
} from '../allocation';
import { ALLOCATION_MAX_PCT, ALLOCATION_MIN_PCT, STAGE_ALLOCATION } from '../../constants';

describe('阶段内置配比（SOP v2 §2 原文数值）', () => {
  it('A0–A2 为 30/30/25/15，合计 100', () => {
    const a = STAGE_ALLOCATION.A0_A2;
    expect(a).toEqual({ LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 15 });
    expect(allocationTotal(a)).toBe(100);
  });

  it('A2–B1 为 28/27/25/20，合计 100', () => {
    const a = STAGE_ALLOCATION.A2_B1;
    expect(a).toEqual({ LISTENING: 28, READING: 27, SPEAKING: 25, WRITING: 20 });
    expect(allocationTotal(a)).toBe(100);
  });

  it('B1–B2 为 25/25/25/25，合计 100', () => {
    const a = STAGE_ALLOCATION.B1_B2;
    expect(a).toEqual({ LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 });
    expect(allocationTotal(a)).toBe(100);
  });

  it('全部内置档位的四项之和都必须是 100（防止手工改动漏掉某一档）', () => {
    for (const [code, allocation] of Object.entries(STAGE_ALLOCATION)) {
      expect(allocationTotal(allocation), `${code} 合计异常`).toBe(100);
    }
  });

  it('defaultAllocationFor 返回深拷贝，改结果不影响常量', () => {
    const copy = defaultAllocationFor('A2_B1');
    copy.LISTENING = 99;
    expect(STAGE_ALLOCATION.A2_B1.LISTENING).toBe(28);
  });
});

describe('checkAllocation：配比校验', () => {
  it('合法配比通过，且归一化为整数', () => {
    const result = checkAllocation({ LISTENING: 28, READING: 27, SPEAKING: 25, WRITING: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.total).toBe(100);
      expect(result.allocation).toEqual({ LISTENING: 28, READING: 27, SPEAKING: 25, WRITING: 20 });
    }
  });

  it('合计 ≠ 100 必须拒绝，并报出差额', () => {
    const result = checkAllocation({ LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 10 });
    expect(result.ok).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'SUM_NOT_100') {
      expect(result.total).toBe(95);
      expect(result.error).toContain('95');
      expect(result.error).toContain('5'); // 差额
    }
  });

  it('合计 105 也拒绝（多给也算错）', () => {
    const result = checkAllocation({ LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'SUM_NOT_100') expect(result.total).toBe(105);
  });

  it('单项低于下限 5% 拒绝', () => {
    const result = checkAllocation({ LISTENING: 60, READING: 35, SPEAKING: 5, WRITING: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SUM_NOT_100');
  });

  it('单项高于上限 60% 拒绝', () => {
    const result = checkAllocation({ LISTENING: 61, READING: 20, SPEAKING: 10, WRITING: 9 });
    expect(result.ok).toBe(false);
  });

  it('负数拒绝并给出 NEGATIVE_OR_NAN', () => {
    const result = checkAllocation({ LISTENING: -10, READING: 60, SPEAKING: 30, WRITING: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NEGATIVE_OR_NAN');
  });

  it('NaN 拒绝', () => {
    const result = checkAllocation({ LISTENING: Number.NaN, READING: 30, SPEAKING: 25, WRITING: 15 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NEGATIVE_OR_NAN');
  });

  it('缺字段按 0 处理，通常合计不足而拒绝', () => {
    const result = checkAllocation({ LISTENING: 50, READING: 50 });
    expect(result.ok).toBe(false);
    // 50+50+0+0：合计虽为 100，但 SPEAKING/WRITING 低于下限，故拒
    if (!result.ok && result.code === 'SUM_NOT_100') expect(result.total).toBe(100);
  });

  it('小数配比先取整再判定（28.4 → 28）', () => {
    const result = checkAllocation({ LISTENING: 28.4, READING: 26.6, SPEAKING: 25, WRITING: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.allocation.LISTENING).toBe(28);
  });

  it('边界值：恰好 MIN 与 MAX 组合成 100 应通过', () => {
    const result = checkAllocation({
      LISTENING: ALLOCATION_MAX_PCT,
      READING: ALLOCATION_MIN_PCT,
      SPEAKING: ALLOCATION_MIN_PCT,
      WRITING: 100 - ALLOCATION_MAX_PCT - ALLOCATION_MIN_PCT * 2,
    });
    expect(result.ok).toBe(true);
  });
});

describe('accumulatePrimaryMinutes：累加与脏数据防御', () => {
  it('按技能分桶累加', () => {
    const out = accumulatePrimaryMinutes([
      { skill: 'LISTENING', minutes: 30 },
      { skill: 'LISTENING', minutes: 20 },
      { skill: 'READING', minutes: 40 },
      { skill: 'FOUNDATION', minutes: 15 },
    ]);
    expect(out).toEqual({ LISTENING: 50, READING: 40, SPEAKING: 0, WRITING: 0, FOUNDATION: 15 });
  });

  it('负数分钟按 0 处理', () => {
    const out = accumulatePrimaryMinutes([{ skill: 'WRITING', minutes: -100 }]);
    expect(out.WRITING).toBe(0);
  });

  it('未知技能归入 FOUNDATION，不污染四技能', () => {
    const out = accumulatePrimaryMinutes([
      { skill: 'MEDIATED', minutes: 60 },
      { skill: 'SOMETHING_NEW', minutes: 30 },
    ]);
    expect(out.LISTENING).toBe(0);
    expect(out.READING).toBe(0);
    expect(out.SPEAKING).toBe(0);
    expect(out.WRITING).toBe(0);
    expect(out.FOUNDATION).toBe(90);
  });

  it('空数组返回全 0', () => {
    expect(accumulatePrimaryMinutes([])).toEqual(emptyPrimaryMinutes());
  });
});

describe('skillShare：四技能分母隔离', () => {
  it('分母只含 L+R+S+W，FOUNDATION 不参与', () => {
    const minutes = {
      LISTENING: 30,
      READING: 30,
      SPEAKING: 25,
      WRITING: 15,
      FOUNDATION: 200, // 大量支持性时间
    };
    const dto = skillShare(minutes);
    expect(dto.denominator).toBe(100);
    expect(dto.foundationMinutes).toBe(200);
    expect(dto.share.LISTENING).toBeCloseTo(0.3, 10);
    expect(dto.share.READING).toBeCloseTo(0.3, 10);
    expect(dto.share.SPEAKING).toBeCloseTo(0.25, 10);
    expect(dto.share.WRITING).toBeCloseTo(0.15, 10);
  });

  it('支持性时间再多也不改变四技能占比（分母隔离的核心断言）', () => {
    const base = { LISTENING: 10, READING: 10, SPEAKING: 10, WRITING: 10 };
    const withFoundation = skillShare({ ...base, FOUNDATION: 999 });
    const withoutFoundation = skillShare({ ...base, FOUNDATION: 0 });
    expect(withFoundation.share).toEqual(withoutFoundation.share);
    expect(withFoundation.denominator).toBe(withoutFoundation.denominator);
  });

  it('分母为 0 时四项占比均为 null（不是 0）', () => {
    const dto = skillShare({ LISTENING: 0, READING: 0, SPEAKING: 0, WRITING: 0, FOUNDATION: 120 });
    expect(dto.denominator).toBe(0);
    expect(dto.share.LISTENING).toBeNull();
    expect(dto.share.READING).toBeNull();
    expect(dto.share.SPEAKING).toBeNull();
    expect(dto.share.WRITING).toBeNull();
    expect(dto.foundationMinutes).toBe(120);
  });

  it('只有一项技能有分钟数时，该项占比 = 1，其余 = 0', () => {
    const dto = skillShare({ LISTENING: 60, READING: 0, SPEAKING: 0, WRITING: 0, FOUNDATION: 0 });
    expect(dto.share.LISTENING).toBe(1);
    expect(dto.share.READING).toBe(0);
    expect(dto.denominator).toBe(60);
  });

  it('负数分钟被夹到 0，不会把分母算小', () => {
    const dto = skillShare({ LISTENING: 100, READING: -50, SPEAKING: 0, WRITING: 0, FOUNDATION: 0 });
    expect(dto.denominator).toBe(100);
    expect(dto.share.LISTENING).toBe(1);
  });
});

describe('allocationDeviation：实际 vs 建议偏离', () => {
  it('分母为 0 返回 null，不返回「四项全欠」', () => {
    const result = allocationDeviation(
      { LISTENING: 0, READING: 0, SPEAKING: 0, WRITING: 0, FOUNDATION: 500 },
      STAGE_ALLOCATION.A0_A2,
    );
    expect(result).toBeNull();
  });

  it('实际与建议一致时偏离接近 0', () => {
    const result = allocationDeviation(
      { LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 15, FOUNDATION: 0 },
      STAGE_ALLOCATION.A0_A2,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.LISTENING).toBeCloseTo(0, 1);
      expect(result.WRITING).toBeCloseTo(0, 1);
    }
  });

  it('偏科时能指出哪项超出、哪项欠缺', () => {
    // 全部时间给听力（60%），其余近乎为 0
    const result = allocationDeviation(
      { LISTENING: 60, READING: 15, SPEAKING: 15, WRITING: 10, FOUNDATION: 0 },
      STAGE_ALLOCATION.A0_A2,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.LISTENING).toBeGreaterThan(0); // 超出建议
      expect(result.SPEAKING).toBeLessThan(0); // 低于建议
      expect(result.WRITING).toBeLessThan(0);
    }
  });
});

describe('splitByAllocation：按配比拆分且总和守恒', () => {
  it('Σ 结果 === totalMinutes（最大余数法）', () => {
    const allocation = STAGE_ALLOCATION.A2_B1; // 28/27/25/20
    for (const total of [1, 7, 13, 60, 100, 137, 240, 361]) {
      const split = splitByAllocation(total, allocation);
      const sum = split.LISTENING + split.READING + split.SPEAKING + split.WRITING;
      expect(sum, `total=${total} 时总和应守恒`).toBe(total);
    }
  });

  it('拆分比例贴近配比（240 分钟 A2–B1）', () => {
    const split = splitByAllocation(240, STAGE_ALLOCATION.A2_B1);
    expect(split.LISTENING).toBe(67); // 240*0.28=67.2
    expect(split.READING).toBe(65); // 240*0.27=64.8
    expect(split.SPEAKING).toBe(60); // 240*0.25=60
    expect(split.WRITING).toBe(48); // 240*0.20=48
    expect(split.LISTENING + split.READING + split.SPEAKING + split.WRITING).toBe(240);
  });

  it('totalMinutes = 0 时全 0', () => {
    const split = splitByAllocation(0, STAGE_ALLOCATION.B1_B2);
    expect(split).toEqual({ LISTENING: 0, READING: 0, SPEAKING: 0, WRITING: 0 });
  });

  it('负数 total 按 0 处理', () => {
    const split = splitByAllocation(-100, STAGE_ALLOCATION.B1_B2);
    expect(split).toEqual({ LISTENING: 0, READING: 0, SPEAKING: 0, WRITING: 0 });
  });

  it('配比合计为 0 时全 0（不除零）', () => {
    const split = splitByAllocation(100, { LISTENING: 0, READING: 0, SPEAKING: 0, WRITING: 0 });
    expect(split).toEqual({ LISTENING: 0, READING: 0, SPEAKING: 0, WRITING: 0 });
  });

  it('小总数也能保证总和守恒（1 分钟）', () => {
    const split = splitByAllocation(1, STAGE_ALLOCATION.A0_A2);
    const sum = split.LISTENING + split.READING + split.SPEAKING + split.WRITING;
    expect(sum).toBe(1);
  });
});

describe('shouldRaiseAllocation：连续两次不足才建议', () => {
  it('仅一次低于目标不触发', () => {
    expect(shouldRaiseAllocation([0.3, 0.1], 0.3)).toBe(false);
  });

  it('连续两次明显低于目标才触发', () => {
    expect(shouldRaiseAllocation([0.1, 0.1], 0.3)).toBe(true);
  });

  it('低于但在容差内不触发', () => {
    // target 0.30，容差 0.05 → 阈值 0.25；0.27 不算明显不足
    expect(shouldRaiseAllocation([0.27, 0.27], 0.3)).toBe(false);
  });

  it('null 被过滤掉，不足两条返回 false', () => {
    expect(shouldRaiseAllocation([null, 0.1], 0.3)).toBe(false);
  });

  it('null 夹在中间不影响有效序列判断', () => {
    expect(shouldRaiseAllocation([0.1, null, 0.1], 0.3)).toBe(true);
  });

  it('空历史返回 false', () => {
    expect(shouldRaiseAllocation([], 0.3)).toBe(false);
  });
});

describe('suggestRaise：提升建议仍须满足配比约束', () => {
  it('提升某技能时从最高者扣减，合计仍为 100', () => {
    const next = suggestRaise(STAGE_ALLOCATION.A0_A2, 'WRITING', 5);
    expect(next).not.toBeNull();
    if (next) {
      expect(allocationTotal(next)).toBe(100);
      expect(next.WRITING).toBe(20); // 15 → 20
      expect(checkAllocation(next).ok).toBe(true);
    }
  });

  it('提升幅度被夹在 5–10 之间', () => {
    const small = suggestRaise(STAGE_ALLOCATION.B1_B2, 'WRITING', 1);
    expect(small).not.toBeNull();
    if (small) expect(small.WRITING).toBe(25 + ALLOCATION_RAISE_MIN);

    const big = suggestRaise(STAGE_ALLOCATION.B1_B2, 'WRITING', 50);
    expect(big).not.toBeNull();
    if (big) expect(big.WRITING).toBe(25 + ALLOCATION_RAISE_MAX);
  });

  it('已在上限时返回 null', () => {
    const atMax = { LISTENING: ALLOCATION_MAX_PCT, READING: 20, SPEAKING: 10, WRITING: 10 };
    expect(suggestRaise(atMax, 'LISTENING', 5)).toBeNull();
  });

  it('无法从其他项扣足时返回 null', () => {
    // 其他三项都在 MIN，无空间可扣
    const tight = {
      LISTENING: 40,
      READING: ALLOCATION_MIN_PCT,
      SPEAKING: ALLOCATION_MIN_PCT,
      WRITING: ALLOCATION_MIN_PCT,
    };
    expect(allocationTotal(tight)).toBe(55); // 非 100，本身就是非法输入
    expect(suggestRaise(tight, 'LISTENING', 10)).toBeNull();
  });
});
