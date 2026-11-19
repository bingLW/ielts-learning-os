/**
 * 被测文件：src/lib/domain/plan.ts
 * 规则来源：PRD §6.2 / SOP §2（基础版 240min / 9 模块不可改；REVIEW_PLAN 恒 10min；
 *           S1 语法类 ≤ 总时长 20%；单科增量 说/听/读 ≤20、其余 ≤15；SENTENCE 在 S1 不增、
 *           S2/S3 ≤+5；增量优先薄弱项 Top3；不变量 Σminutes === dailyMinutes 且 sortOrder 等于主线顺序）
 *           + PRD Q3（S0 只生成 3 个基线任务，合计 90min）。
 */

import { describe, expect, it } from 'vitest';
import {
  S0_TOTAL_MINUTES,
  allocateExtra,
  basePlanMinutes,
  generateDailyPlan,
  grammarCapMinutes,
  grammarMinutesOf,
} from '../plan';
import {
  DAILY_MINUTES_MAX,
  DAILY_MINUTES_MIN,
  EXTRA_CAP_DEFAULT,
  EXTRA_CAP_SKILL,
  GRAMMAR_CAP_RATIO,
  MODULE_META,
  MODULE_ORDER,
  REVIEW_PLAN_FIXED,
  S0_MODULES,
  SENTENCE_EXTRA_CAP,
} from '../../constants';
import type { ModuleId, StageCode, WeakModuleHint } from '../../types';

/** 9 模块分钟合计（只算主线 9 项）。 */
function sumOf(allocation: Record<ModuleId, number>): number {
  return MODULE_ORDER.reduce((total, module) => total + (allocation[module] ?? 0), 0);
}

function mustPlan(
  result: ReturnType<typeof generateDailyPlan>,
  hint: string,
): Extract<ReturnType<typeof generateDailyPlan>, { ok: true }> {
  expect(result.ok, hint).toBe(true);
  if (!result.ok) throw new Error(`${hint}（实际返回失败码 ${result.code}）`);
  return result;
}

function minutesOf(
  plan: Extract<ReturnType<typeof generateDailyPlan>, { ok: true }>,
  module: ModuleId,
): number {
  return plan.items.find((item) => item.module === module)?.minutes ?? 0;
}

/** 各模块单日增量上限（S2/S3：语法也能 +15）。 */
const CAPS_S2: Record<string, number> = {
  VOCAB_REVIEW: EXTRA_CAP_DEFAULT,
  GRAMMAR: EXTRA_CAP_DEFAULT,
  LISTENING: EXTRA_CAP_SKILL,
  READING: EXTRA_CAP_SKILL,
  SPEAKING: EXTRA_CAP_SKILL,
  WRITING: EXTRA_CAP_DEFAULT,
  SENTENCE: SENTENCE_EXTRA_CAP,
  REVIEW_PLAN: 0,
  EXTENSIVE: EXTRA_CAP_DEFAULT,
};

describe('基础版数值不可改', () => {
  it('9 模块合计 = 240 分钟', () => {
    expect(sumOf(basePlanMinutes()), 'SOP §2 基础版合计必须是 240 分钟').toBe(240);
  });

  it('每个模块的基础分钟数与 MODULE_META 一致', () => {
    const base = basePlanMinutes();
    for (const module of MODULE_ORDER) {
      expect(base[module], `${module} 基础分钟应与 MODULE_META 一致`).toBe(
        MODULE_META[module].defaultMinutes,
      );
    }
  });

  it('复盘与计划恒为 10 分钟', () => {
    expect(basePlanMinutes().REVIEW_PLAN, '复盘基础值').toBe(REVIEW_PLAN_FIXED);
    const plan = mustPlan(
      generateDailyPlan({ dailyMinutes: 300, stageCode: 'S3_B1_IELTS' }),
      '300 分钟计划应能生成',
    );
    expect(minutesOf(plan, 'REVIEW_PLAN'), 'SOP：复盘与计划不增不减，恒 10 分钟').toBe(10);
  });

  it('S0 基线任务合计 90 分钟', () => {
    expect(S0_TOTAL_MINUTES, '30 + 30 + 30').toBe(90);
    expect(S0_MODULES, 'S0 只有三个基线任务').toEqual([
      'BASELINE_LISTEN',
      'BASELINE_READ',
      'BASELINE_OUTPUT',
    ]);
  });
});

describe('generateDailyPlan —— 不变量', () => {
  const stages: StageCode[] = ['S1_A0_A2', 'S2_A2_B1', 'S3_B1_IELTS'];
  const presets = [240, 270, 300];

  it('240 / 270 / 300 三档 × 三个阶段：Σminutes === dailyMinutes', () => {
    for (const stageCode of stages) {
      for (const dailyMinutes of presets) {
        const plan = mustPlan(
          generateDailyPlan({ dailyMinutes, stageCode }),
          `${stageCode} / ${dailyMinutes} 分钟应能生成计划`,
        );
        expect(
          plan.totalMinutes,
          `${stageCode}/${dailyMinutes}：totalMinutes 必须等于入参`,
        ).toBe(dailyMinutes);
        expect(
          plan.items.reduce((total, item) => total + item.minutes, 0),
          `${stageCode}/${dailyMinutes}：Σminutes 必须等于 dailyMinutes`,
        ).toBe(dailyMinutes);
      }
    }
  });

  it('sortOrder 严格等于 SOP 主线顺序', () => {
    const plan = mustPlan(
      generateDailyPlan({ dailyMinutes: 240, stageCode: 'S2_A2_B1' }),
      '240 分钟标准计划',
    );
    expect(plan.items.length, '240 分钟时 9 个模块都有时间').toBe(9);
    plan.items.forEach((item, index) => {
      expect(item.sortOrder, `${item.module} 的 sortOrder 应为 ${index}`).toBe(index);
      expect(item.module, `第 ${index} 位必须是主线顺序`).toBe(MODULE_ORDER[index]);
    });
  });

  it('240 分钟基础版每一模块分钟数与基础表一致', () => {
    const plan = mustPlan(
      generateDailyPlan({ dailyMinutes: 240, stageCode: 'S2_A2_B1' }),
      '240 分钟即基础版',
    );
    const base = basePlanMinutes();
    for (const item of plan.items) {
      expect(item.minutes, `${item.module} 无增量时应等于基础值`).toBe(base[item.module]);
    }
  });

  it('dailyMinutes 越界 → MINUTES_OUT_OF_RANGE（不抛异常）', () => {
    const below = generateDailyPlan({ dailyMinutes: DAILY_MINUTES_MIN - 1, stageCode: 'S2_A2_B1' });
    expect(below.ok, '低于 240 分钟必须拒绝').toBe(false);
    if (!below.ok) expect(below.code).toBe('MINUTES_OUT_OF_RANGE');

    const above = generateDailyPlan({ dailyMinutes: DAILY_MINUTES_MAX + 1, stageCode: 'S2_A2_B1' });
    expect(above.ok, '高于 300 分钟必须拒绝').toBe(false);

    const notNumber = generateDailyPlan({ dailyMinutes: Number.NaN, stageCode: 'S2_A2_B1' });
    expect(notNumber.ok, 'NaN 必须拒绝').toBe(false);
  });
});

describe('generateDailyPlan —— S1 语法 20% 上限', () => {
  it('300 分钟 + 语法是 Top1 薄弱项：语法仍 ≤ 60 分钟', () => {
    const plan = mustPlan(
      generateDailyPlan({
        dailyMinutes: 300,
        stageCode: 'S1_A0_A2',
        weakTop3: [{ module: 'GRAMMAR', weight: 1 }],
      }),
      'S1 300 分钟计划',
    );
    const cap = grammarCapMinutes(300);
    expect(cap, '300 × 20% = 60').toBe(60);
    expect(minutesOf(plan, 'GRAMMAR'), 'S1 语法必须受 20% 上限约束').toBeLessThanOrEqual(cap);
    expect(
      plan.warnings.some((warning) => warning.includes('语法')),
      '薄弱项含语法时要提示「已优先分配给其他薄弱项」',
    ).toBe(true);
  });

  it('270 分钟 + 语法薄弱：语法增量被 20% 天花板压住（≤54 分钟）', () => {
    const plan = mustPlan(
      generateDailyPlan({
        dailyMinutes: 270,
        stageCode: 'S1_A0_A2',
        weakTop3: [{ module: 'GRAMMAR', weight: 0.9 }],
      }),
      'S1 270 分钟计划',
    );
    expect(minutesOf(plan, 'GRAMMAR'), '270 × 20% = 54 为语法上限').toBeLessThanOrEqual(
      grammarCapMinutes(270),
    );
  });

  it('S1 当日语法类任务（GRAMMAR + SENTENCE）合计必须 ≤ 总时长 20%', () => {
    const plan = mustPlan(
      generateDailyPlan({ dailyMinutes: 240, stageCode: 'S1_A0_A2' }),
      'S1 标准 240 分钟计划',
    );
    const grammarLike = grammarMinutesOf(
      plan.items.map((item) => ({ module: item.module, plannedMinutes: item.minutes })),
    );
    expect(
      grammarLike,
      'D4（已修复）：语法类 = GRAMMAR + SENTENCE 合计必须 ≤ 240 × 20% = 48；' +
        '实现侧在容量表里先扣掉基础 SENTENCE 15 分钟，再把超出部分转给其他模块',
    ).toBeLessThanOrEqual(grammarCapMinutes(240));
  });

  it('S2/S3 不受 20% 约束（语法可正常拿到 15 分钟增量）', () => {
    const plan = mustPlan(
      generateDailyPlan({
        dailyMinutes: 300,
        stageCode: 'S2_A2_B1',
        weakTop3: [{ module: 'GRAMMAR', weight: 1 }],
      }),
      'S2 300 分钟计划',
    );
    expect(minutesOf(plan, 'GRAMMAR'), 'S1 之外语法可 +15 → 55').toBe(55);
  });
});

describe('allocateExtra —— 单科增量上限', () => {
  it('S1：SENTENCE 不增、REVIEW_PLAN 不增', () => {
    const base = basePlanMinutes();
    const result = allocateExtra(60, base, [], 'S1_A0_A2');
    expect(result.SENTENCE - base.SENTENCE, 'S1 句子成分不增').toBe(0);
    expect(result.REVIEW_PLAN - base.REVIEW_PLAN, '复盘恒 10，不参与增量分配').toBe(0);
    expect(sumOf(result), 'Σ 必须等于 240 + 60').toBe(300);
  });

  it('S2：SENTENCE 最多 +5', () => {
    const base = basePlanMinutes();
    const result = allocateExtra(5, base, [{ module: 'SENTENCE', weight: 1 }], 'S2_A2_B1');
    expect(result.SENTENCE - base.SENTENCE, 'S2 句子成分上限 +5').toBe(SENTENCE_EXTRA_CAP);
  });

  it('S1：即使 SENTENCE 是 Top1 薄弱项也拿不到分钟', () => {
    const base = basePlanMinutes();
    const result = allocateExtra(5, base, [{ module: 'SENTENCE', weight: 1 }], 'S1_A0_A2');
    expect(result.SENTENCE - base.SENTENCE, 'S1 句子成分不增，增量改给别人').toBe(0);
    expect(sumOf(result), '增量为 5 必须全部落地，不能丢').toBe(245);
  });

  it('S2：听说读 ≤20，其余 ≤15，且 Σ 不丢分钟', () => {
    const base = basePlanMinutes();
    const result = allocateExtra(60, base, [], 'S2_A2_B1');
    for (const module of MODULE_ORDER) {
      const increase = result[module] - base[module];
      expect(increase, `${module} 增量 ${increase} 超过上限 ${CAPS_S2[module]}`).toBeLessThanOrEqual(
        CAPS_S2[module],
      );
      expect(increase, `${module} 增量不应为负`).toBeGreaterThanOrEqual(0);
    }
    expect(sumOf(result), 'Σ 必须等于 240 + 60').toBe(300);
  });
});

describe('allocateExtra —— 薄弱项优先与兜底', () => {
  const base = basePlanMinutes();

  it('增量优先给权重最高的薄弱项', () => {
    const hints: WeakModuleHint[] = [
      { module: 'LISTENING', weight: 0.9 },
      { module: 'READING', weight: 0.8 },
      { module: 'WRITING', weight: 0.7 },
    ];
    const result = allocateExtra(40, base, hints, 'S2_A2_B1');
    expect(result.LISTENING - base.LISTENING, '听力最先被补满（20）').toBe(EXTRA_CAP_SKILL);
    expect(result.READING - base.READING, '阅读第二个被补满（20）').toBe(EXTRA_CAP_SKILL);
    expect(result.WRITING - base.WRITING, '增量已用完，写作拿不到').toBe(0);
    expect(sumOf(result), 'Σ = 240 + 40').toBe(280);
  });

  it('同一模块重复出现在 Top3 时只乘一次权重（不叠加）', () => {
    const result = allocateExtra(
      20,
      base,
      [
        { module: 'WRITING', weight: 0.9 },
        { module: 'WRITING', weight: 0.5 },
      ],
      'S2_A2_B1',
    );
    expect(result.WRITING - base.WRITING, '同模块去重后最多 +15，不能变成 +30').toBe(
      EXTRA_CAP_DEFAULT,
    );
  });

  it('增量 0 → 原样返回基础表', () => {
    expect(allocateExtra(0, base, [{ module: 'LISTENING', weight: 1 }], 'S2_A2_B1')).toEqual(base);
  });

  it('D9：增量超出单科容量时不得越界分配', () => {
    // 本用例 T = 240 + 200 = 440，语法容量已恢复 15：
    // 词汇 15 / 语法 15 / 听力·阅读·口语 20 / 写作 15 / 句子成分 0 / 复盘 0 / 泛练 15 = 120
    // （合法区间 T ≤ 300 时语法容量为 0~5，合计只有 105~110，见 docs/04-qa-report.md §3.2）
    const capsS1: Record<string, number> = {
      VOCAB_REVIEW: EXTRA_CAP_DEFAULT,
      GRAMMAR: EXTRA_CAP_DEFAULT,
      LISTENING: EXTRA_CAP_SKILL,
      READING: EXTRA_CAP_SKILL,
      SPEAKING: EXTRA_CAP_SKILL,
      WRITING: EXTRA_CAP_DEFAULT,
      SENTENCE: 0,
      REVIEW_PLAN: 0,
      EXTENSIVE: EXTRA_CAP_DEFAULT,
    };
    const result = allocateExtra(200, base, [], 'S1_A0_A2');

    expect(
      sumOf(result),
      'D9：只落地 240 + 容量总和 120 = 360 分钟；剩余 80 分钟不得硬塞给任何模块',
    ).toBe(360);

    for (const module of MODULE_ORDER) {
      const increase = result[module] - base[module];
      expect(
        increase,
        `D9：${module} 增量 ${increase} 超过单科上限 ${capsS1[module]}`,
      ).toBeLessThanOrEqual(capsS1[module]);
      expect(increase, `D9：${module} 增量不应为负`).toBeGreaterThanOrEqual(0);
    }

    expect(result.LISTENING - base.LISTENING, 'D9：听力最多 +20，不能被当成兜底垃圾桶').toBe(
      EXTRA_CAP_SKILL,
    );
    expect(result.SENTENCE - base.SENTENCE, 'D9：S1 句子成分不增').toBe(0);
    expect(
      result.GRAMMAR + result.SENTENCE,
      'D9：语法类 55 + 15 = 70，未超 440 × 20% = 88',
    ).toBeLessThanOrEqual(grammarCapMinutes(440));
  });

  it('D9：合法区间内容量恒足够，拦截分支不得误报 CAPACITY_EXCEEDED', () => {
    for (const stageCode of ['S1_A0_A2', 'S2_A2_B1', 'S3_B1_IELTS'] as StageCode[]) {
      for (const dailyMinutes of [240, 270, 300]) {
        const plan = generateDailyPlan({
          dailyMinutes,
          stageCode,
          weakTop3: [
            { module: 'GRAMMAR', weight: 1 },
            { module: 'SENTENCE', weight: 0.9 },
            { module: 'REVIEW_PLAN', weight: 0.8 },
          ],
        });
        expect(
          plan.ok,
          `D9：${stageCode}/${dailyMinutes} 增量上限 60 小于最小容量 105（S1），不应返回 CAPACITY_EXCEEDED`,
        ).toBe(true);
        if (plan.ok) {
          expect(plan.totalMinutes, 'Σ 仍需严格等于 dailyMinutes').toBe(dailyMinutes);
        }
      }
    }
  });
});

describe('generateDailyPlan —— S0 阶段', () => {
  it('只生成 3 个基线任务，合计 90 分钟，并给出说明', () => {
    const plan = mustPlan(generateDailyPlan({ dailyMinutes: 240, stageCode: 'S0_PREP' }), 'S0 计划');
    expect(plan.items.length, '阶段零只有 3 个基线任务').toBe(3);
    expect(plan.items.map((item) => item.module)).toEqual([...S0_MODULES]);
    expect(plan.totalMinutes, '合计 90 分钟').toBe(S0_TOTAL_MINUTES);
    expect(plan.warnings.length > 0, '必须提示「暂不生成 9 模块计划」').toBe(true);
  });

  it('S0 的 sortOrder 从 0 递增', () => {
    const plan = mustPlan(generateDailyPlan({ dailyMinutes: 240, stageCode: 'S0_PREP' }), 'S0 计划');
    expect(plan.items.map((item) => item.sortOrder)).toEqual([0, 1, 2]);
  });

  it('D8：S0 也必须受每日分钟数范围约束', () => {
    const plan = generateDailyPlan({ dailyMinutes: 100, stageCode: 'S0_PREP' });
    expect(plan.ok, 'D8：范围校验先于 S0 特例执行，100 分钟必须被拒绝').toBe(false);
    if (!plan.ok) {
      expect(plan.code, 'D8：S0 的非法分钟数同样返回 MINUTES_OUT_OF_RANGE').toBe(
        'MINUTES_OUT_OF_RANGE',
      );
    }
  });
});

describe('语法类辅助口径', () => {
  it('grammarMinutesOf 统计 GRAMMAR + SENTENCE', () => {
    expect(
      grammarMinutesOf([
        { module: 'GRAMMAR', plannedMinutes: 40 },
        { module: 'SENTENCE', plannedMinutes: 15 },
        { module: 'LISTENING', plannedMinutes: 45 },
      ]),
      '语法类 = 40 + 15 = 55',
    ).toBe(55);
  });

  it('负分钟不参与求和', () => {
    expect(grammarMinutesOf([{ module: 'GRAMMAR', plannedMinutes: -20 }]), '负值按 0').toBe(0);
  });

  it('grammarCapMinutes 向下取整', () => {
    expect(GRAMMAR_CAP_RATIO, '语法类上限 20%').toBe(0.2);
    expect(grammarCapMinutes(240), '240 × 20% = 48').toBe(48);
    expect(grammarCapMinutes(250), '250 × 20% = 50').toBe(50);
    expect(grammarCapMinutes(247), '49.4 向下取整 = 49').toBe(49);
  });
});
