/**
 * `splitProposalAcrossDays` 的七条规则逐条验证（T13 §2）。
 *
 * 为什么这个纯函数值得 20+ 条用例：它是"草案"与"真实预算"之间唯一的换算器。
 * 算错的后果不是报错，而是**用户确认后计划超支**（10-24 预算 45 分钟却排了 60 分钟），
 * 或者内容被静默丢掉（少了 30 分钟的那一段，谁也不知道它去哪了）。
 */

import { describe, expect, it } from 'vitest';
import {
  describeBudgetViolations,
  splitProposalAcrossDays,
  validateProposalAgainstBudget,
  type BudgetDay,
  type ProposalSeed,
} from '../taskProposal';

/** 造一天预算。 */
function day(date: string, minutes: number, isRestDay = false): BudgetDay {
  return { date, minutes, isRestDay };
}

/** 造一条待排内容。 */
function seed(title: string, suggestedMinutes: number, module = 'READING'): ProposalSeed {
  return { module, targetSkill: 'READING', title, suggestedMinutes };
}

describe('规则①粒度对齐：按 15/30/60 向上取整，0 抬到粒度最小值', () => {
  it('granularity=30 时 20 分钟抬到 30', () => {
    const result = splitProposalAcrossDays([seed('词汇巩固', 20)], [day('2025-10-24', 120)], {
      granularity: 30,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].minutes).toBe(30);
    expect(result.items[0].granularity).toBe(30);
    expect(result.totalMinutes).toBe(30);
  });

  it('granularity=15 时 7 分钟抬到 15，正好整倍数不动', () => {
    const result = splitProposalAcrossDays(
      [seed('碎片', 7), seed('整块', 45)],
      [day('2025-10-24', 120)],
      { granularity: 15 },
    );
    expect(result.items.map((item) => item.minutes)).toEqual([15, 45]);
  });

  it('0 / 负数 / NaN 一律抬到粒度最小值（草案里不出现 0 分钟条目）', () => {
    const result = splitProposalAcrossDays(
      [seed('零', 0), seed('负', -30), seed('非数', Number.NaN)],
      [day('2025-10-24', 120)],
      { granularity: 30 },
    );
    expect(result.items.map((item) => item.minutes)).toEqual([30, 30, 30]);
  });
});

describe('规则②休息日与 0 预算日不排', () => {
  it('isRestDay 的那天没有任何条目，内容顺延到下一天', () => {
    const result = splitProposalAcrossDays(
      [seed('精读', 45)],
      [day('2025-10-24', 0, true), day('2025-10-25', 60)],
      { granularity: 15 },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].date).toBe('2025-10-25');
    expect(result.rationale).toContain('已跳过 1 个休息日');
  });

  it('minutes=0（非休息日）同样跳过 —— 0 预算就是排不进', () => {
    const result = splitProposalAcrossDays(
      [seed('精读', 30)],
      [day('2025-10-24', 0), day('2025-10-25', 60)],
      { granularity: 30 },
    );
    expect(result.items[0].date).toBe('2025-10-25');
  });
});

describe('规则③顺序贪心装箱：装得下整条放，装不下填满再顺延', () => {
  it('单日装得下 → 1 条、日期 = 首日、overflowDays 为 0', () => {
    const result = splitProposalAcrossDays(
      [seed('词汇巩固', 30)],
      [day('2025-10-24', 60), day('2025-10-25', 60)],
      { granularity: 30 },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].date).toBe('2025-10-24');
    expect(result.overflowDays).toBe(0);
    expect(result.rationale).toContain('2025-10-24（30 分钟）');
  });

  it('跨 2 天拆分 → 每日都不超过当日预算', () => {
    const days = [day('2025-10-24', 60), day('2025-10-25', 60)];
    const result = splitProposalAcrossDays(
      [seed('精读训练', 60), seed('词汇巩固', 35)],
      days,
      { granularity: 15 },
    );
    const used = new Map<string, number>();
    for (const item of result.items) {
      used.set(item.date, (used.get(item.date) ?? 0) + item.minutes);
    }
    expect(used.get('2025-10-24')).toBeLessThanOrEqual(60);
    expect(used.get('2025-10-25')).toBeLessThanOrEqual(60);
    // 60 + 45（35 按 15 向上取整）= 105
    expect(result.totalMinutes).toBe(105);
    expect(result.overflowDays).toBe(0);
    expect(result.items.map((item) => item.date)).toEqual(['2025-10-24', '2025-10-25']);
  });

  it('当日剩余被粒度切碎后不足一个粒度 → 余量顺延到次日（并计入 overflow）', () => {
    // 10-24 只有 45 分钟：60 分钟的项填 45，剩 15 已经不够（剩余 0）；
    // 10-25 先接 15，再放 30，剩 5 不够一个粒度 → 15 顺延到 10-26
    const result = splitProposalAcrossDays(
      [seed('精读训练', 60), seed('词汇巩固', 45)],
      [day('2025-10-24', 45), day('2025-10-25', 50)],
      { granularity: 15 },
    );
    expect(result.totalMinutes).toBe(105);
    expect(result.overflowDays).toBe(1);
    expect(result.items.map((item) => [item.date, item.minutes])).toEqual([
      ['2025-10-24', 45],
      ['2025-10-25', 15],
      ['2025-10-25', 30],
      ['2025-10-26', 15],
    ]);
  });

  it('当日剩余不足一个粒度 → 不硬塞，直接下一天', () => {
    // 第一天 45 分钟：放完 30 之后剩 15；下一条 30 放不下，且剩 15 正好等于粒度可填
    const result = splitProposalAcrossDays(
      [seed('A', 30), seed('B', 60)],
      [day('2025-10-24', 45), day('2025-10-25', 60)],
      { granularity: 30 },
    );
    // 45 → 放在 10-24；B 需要 60 → 10-25
    expect(result.items.map((item) => [item.title, item.date, item.minutes])).toEqual([
      ['A', '2025-10-24', 30],
      ['B', '2025-10-25', 60],
    ]);
  });
});

describe('规则④单项大于任何单日预算 → 切成多段，任何一天都不超预算', () => {
  it('90 分钟的项在 60 分钟的日子里被切成 2 段', () => {
    const result = splitProposalAcrossDays(
      [seed('整篇精读', 90)],
      [day('2025-10-24', 60), day('2025-10-25', 60)],
      { granularity: 30 },
    );
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.minutes)).toEqual([60, 30]);
    expect(result.items.map((item) => item.date)).toEqual(['2025-10-24', '2025-10-25']);
    // 同标题、同模块，但带分段说明
    expect(result.items.map((item) => item.title)).toEqual(['整篇精读', '整篇精读']);
    expect(result.items.map((item) => item.module)).toEqual(['READING', 'READING']);
    expect(result.items[0].segmentLabel).toBe('拆分第 1/2 段');
    expect(result.items[1].segmentLabel).toBe('拆分第 2/2 段');
    expect(result.rationale).toContain('因单日预算不足被拆成多段');
  });

  it('拆出来的段永远不会让某一天超预算（逐日断言）', () => {
    const days = [day('2025-10-24', 60), day('2025-10-25', 30)];
    const result = splitProposalAcrossDays([seed('长任务', 150)], days, { granularity: 30 });
    const check = validateProposalAgainstBudget(
      result.items.map((item) => ({ date: item.date, minutes: item.minutes })),
      days,
    );
    expect(check.ok).toBe(true);
    expect(check.violations).toEqual([]);
    expect(result.totalMinutes).toBe(150);
  });
});

describe('规则⑤天数用尽 → 按最后一个非休息日预算顺延，并记 overflowDays', () => {
  it('7 天塞不下 → overflowDays > 0，rationale 写明"超出"', () => {
    const days = [
      day('2025-10-24', 30),
      day('2025-10-25', 30),
      day('2025-10-26', 30),
    ];
    const result = splitProposalAcrossDays(
      [seed('A', 30), seed('B', 30), seed('C', 30), seed('D', 30)],
      days,
      { granularity: 30 },
    );
    expect(result.overflowDays).toBe(1);
    expect(result.rationale).toContain('总时长超出已设定预算范围 1 天');
    // 第 4 条被排到窗口之后（10-27），且用的基准是最后一天的预算 30
    expect(result.items[3].date).toBe('2025-10-27');
    expect(result.items[3].minutes).toBe(30);
  });

  it('顺延基准取"最后一个非休息日"，不是 0 也不是凭空 60', () => {
    const days = [day('2025-10-24', 90), day('2025-10-25', 0, true)];
    const result = splitProposalAcrossDays([seed('A', 120)], days, { granularity: 30 });
    // 第一天 90，剩 30 → 顺延到 10-26，基准 90（不是 0）
    expect(result.items.map((item) => [item.date, item.minutes])).toEqual([
      ['2025-10-24', 90],
      ['2025-10-26', 30],
    ]);
    expect(result.overflowDays).toBe(1);
  });

  it('maxDays 只限制"给定窗口内用几天"，超出的内容照规则⑤顺延而不是丢弃', () => {
    const days = [day('2025-10-24', 60), day('2025-10-25', 60), day('2025-10-26', 60)];
    const result = splitProposalAcrossDays([seed('A', 90)], days, {
      granularity: 30,
      maxDays: 1,
    });
    expect(result.items.map((item) => item.date)).toEqual(['2025-10-24', '2025-10-25']);
    expect(result.overflowDays).toBe(1);
    expect(result.totalMinutes).toBe(90);
  });
});

describe('规则⑥空输入不抛错', () => {
  it('空 seeds → items 空、totalMinutes 0、rationale 固定文案', () => {
    const result = splitProposalAcrossDays([], [day('2025-10-24', 60)], { granularity: 30 });
    expect(result.items).toEqual([]);
    expect(result.totalMinutes).toBe(0);
    expect(result.overflowDays).toBe(0);
    expect(result.rationale).toBe('没有可排入的内容');
  });

  it('有内容但一天都排不了（全是休息日）→ 不静默丢弃，明确说明', () => {
    const result = splitProposalAcrossDays(
      [seed('A', 30)],
      [day('2025-10-24', 0, true), day('2025-10-25', 0, true)],
      { granularity: 30 },
    );
    expect(result.items).toEqual([]);
    expect(result.rationale).toContain('没有可用预算');
  });
});

describe('规则⑦确定性：同输入两次输出逐字相同', () => {
  it('两次调用 toEqual，且条目顺序稳定', () => {
    const seeds = [seed('A', 45), seed('B', 75), seed('C', 30)];
    const days = [day('2025-10-24', 60), day('2025-10-25', 45), day('2025-10-26', 60)];
    const first = splitProposalAcrossDays(seeds, days, { granularity: 15 });
    const second = splitProposalAcrossDays(seeds, days, { granularity: 15 });
    expect(first).toEqual(second);
    expect(first.items.map((item) => item.title)).toEqual(
      second.items.map((item) => item.title),
    );
  });
});

describe('validateProposalAgainstBudget：确认前的最后一道闸', () => {
  it('正例：每天都装得下 → ok，violations 为空', () => {
    const days = [day('2025-10-24', 45)];
    const result = validateProposalAgainstBudget([{ date: '2025-10-24', minutes: 45 }], days);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('反例：同日合计超预算 → 报出预算与实排分钟', () => {
    const days = [day('2025-10-24', 45)];
    const result = validateProposalAgainstBudget(
      [
        { date: '2025-10-24', minutes: 30 },
        { date: '2025-10-24', minutes: 30 },
      ],
      days,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { date: '2025-10-24', budgetMinutes: 45, allocatedMinutes: 60 },
    ]);
    expect(describeBudgetViolations(result.violations)).toBe(
      '草案超出每日预算：2025-10-24 预算 45 分钟，草案排了 60 分钟',
    );
  });

  it('休息日预算视为 0：排上去就是超支（不是"没预算所以放行"）', () => {
    const result = validateProposalAgainstBudget(
      [{ date: '2025-10-24', minutes: 15 }],
      [day('2025-10-24', 0, true)],
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].budgetMinutes).toBe(0);
  });

  it('草案自己顺延出来的日期不在 days 里 → 不做判定（留给计划层再校验）', () => {
    const result = validateProposalAgainstBudget(
      [{ date: '2025-12-31', minutes: 600 }],
      [day('2025-10-24', 45)],
    );
    expect(result.ok).toBe(true);
  });
});
