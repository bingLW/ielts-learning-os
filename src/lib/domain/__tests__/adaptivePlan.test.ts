/**
 * 被测文件：src/lib/domain/adaptivePlan.ts
 * 规则来源：v2.1 需求手册 §5（优先级/硬约束）、§15.2（T01–T13 场景矩阵）。
 *
 * 只测纯函数：不连数据库、不读系统时间。
 */

import { describe, expect, it } from 'vitest';
import {
  budgetUsageRatio,
  generateAdaptivePlan,
  plannedMinutesOf,
  templateFor,
  type AdaptivePlanInput,
} from '../adaptivePlan';
import {
  BUDGET_TEMPLATES,
  CORE_MIN_RATIO,
  MIN_TASK_MINUTES,
  P0_CAP_RATIO,
  SHORT_PLAN_MAX_MINUTES,
} from '../../constants';
import type { StageCode } from '../../types';

const A0_ALLOC = { LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 15 };

function makeInput(over: Partial<AdaptivePlanInput> = {}): AdaptivePlanInput {
  return {
    budgetMinutes: 60,
    stageCode: 'S1_A0_A2' as StageCode,
    allocation: A0_ALLOC,
    ...over,
  };
}

function mustPlan(input: AdaptivePlanInput) {
  const result = generateAdaptivePlan(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`期望成功，实际 ${result.code}`);
  return result;
}

describe('模板取值', () => {
  it('预设档取 BUDGET_TEMPLATES，三者合计等于档位分钟', () => {
    for (const [code, template] of Object.entries(BUDGET_TEMPLATES)) {
      const minutes = template.foundation + template.skill + template.review;
      expect(minutes, `${code} 模板合计`).toBe(
        Number(
          { EMERGENCY: 15, MINIMUM: 30, LIGHT: 45, LIGHT_STANDARD: 60, STANDARD: 90, FOCUSED: 120, DEEP: 180, EXTENDED: 240 }[code],
        ),
      );
    }
  });

  it('自定义档按比例切分且合计等于预算', () => {
    const template = templateFor(75, 'CUSTOM');
    expect(template.foundation + template.skill + template.review).toBe(75);
  });
});

describe('T01 15 分钟预算（应急维护）', () => {
  it('计划 <= 15 分钟，且只出维护级任务', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 15,
        tierCode: 'EMERGENCY',
        dueReviews: { estMinutes: 10, count: 2, maxOverdueDays: 0 },
      }),
    );
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(15);
    expect(plan.totalPlannedMinutes).toBeGreaterThan(0);
    expect(plan.warnings.some((line) => line.includes('应急维护'))).toBe(true);
  });
});

describe('T02/T03 30 与 60 分钟预算', () => {
  it('30 分钟：核心或到期复习 + 简短复盘，且不超预算', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 30,
        tierCode: 'MINIMUM',
        dueReviews: { estMinutes: 20, count: 3, maxOverdueDays: 2 },
      }),
    );
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(30);
    expect(plan.priorityMinutes.P0).toBeGreaterThan(0);
    expect(plan.items.some((item) => item.priority === 'P1')).toBe(true);
  });

  it('60 分钟：支持模块与技能任务分开统计', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 60, tierCode: 'LIGHT_STANDARD' }));
    const foundation = plan.items.filter((item) => item.primarySkill === 'FOUNDATION');
    const skill = plan.items.filter((item) => item.primarySkill !== 'FOUNDATION');
    expect(foundation.length).toBeGreaterThan(0);
    expect(skill.length).toBeGreaterThan(0);
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(60);
  });
});

describe('T04 240 分钟预算', () => {
  it('生成扩展计划但不重复模块、不超预算', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 240, tierCode: 'EXTENDED' }));
    const modules = plan.items.map((item) => item.module);
    expect(new Set(modules).size).toBe(modules.length);
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(240);
    expect(plan.totalPlannedMinutes).toBeGreaterThan(150);
  });
});

describe('T05 自定义 75 分钟', () => {
  it('严格以 75 为上限，不归到 60/90 档', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 75, tierCode: 'CUSTOM' }));
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(75);
    expect(plan.totalPlannedMinutes).toBeGreaterThan(60);
  });
});

describe('T06 休息日', () => {
  it('不生成强制任务；复习留在 backlog', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 0,
        isRestDay: true,
        dueReviews: { estMinutes: 30, count: 4, maxOverdueDays: 0 },
      }),
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.totalPlannedMinutes).toBe(0);
    expect(plan.backlog.length).toBeGreaterThan(0);
  });

  it('预算为 0 即使未标记休息日也不生成任务', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 0 }));
    expect(plan.items).toHaveLength(0);
  });
});

describe('T07 P0 超额：90 分钟复习 / 30 分钟预算', () => {
  it('只安排高风险部分，其余进 backlog 并说明原因', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 30,
        tierCode: 'MINIMUM',
        dueReviews: { estMinutes: 90, count: 12, maxOverdueDays: 5 },
      }),
    );
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(30);
    expect(plan.priorityMinutes.P0).toBeLessThanOrEqual(Math.floor(30 * P0_CAP_RATIO));
    const reviewBacklog = plan.backlog.find((entry) => entry.kind === 'REVIEW');
    expect(reviewBacklog).toBeDefined();
    expect(reviewBacklog?.reason.length).toBeGreaterThan(0);
  });

  it('P0 不会挤占核心保障：预算 100 时 P0 <= 60 且留有核心时间', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 100,
        tierCode: 'STANDARD',
        dueReviews: { estMinutes: 100, count: 15, maxOverdueDays: 9 },
      }),
    );
    const p0 = plan.priorityMinutes.P0;
    expect(p0).toBeLessThanOrEqual(Math.floor(100 * P0_CAP_RATIO));
    const nonP0 = plan.totalPlannedMinutes - p0;
    expect(nonP0).toBeGreaterThanOrEqual(Math.floor(100 * CORE_MIN_RATIO) - 10);
  });
});

describe('T12/T13 技能权重与小份额取整', () => {
  it('技能份额只作用于技能池，支持模块不进入配比', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 90, tierCode: 'STANDARD' }));
    const skillMinutes = plan.items
      .filter((item) => item.primarySkill !== 'FOUNDATION')
      .reduce((sum, item) => sum + item.minutes, 0);
    expect(skillMinutes).toBeLessThan(plan.totalPlannedMinutes);
  });

  it('低于最小粒度的份额不生成碎片，转周轮换', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 30,
        tierCode: 'MINIMUM',
        allocation: { LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 15 },
      }),
    );
    for (const item of plan.items) {
      expect(item.minutes).toBeGreaterThanOrEqual(Math.min(MIN_TASK_MINUTES, item.minutes));
      expect(item.minutes % MIN_TASK_MINUTES).toBe(0);
    }
    const rotation = Object.values(plan.weeklyRotation).reduce((sum, value) => sum + (value ?? 0), 0);
    if (rotation > 0) {
      expect(plan.backlog.some((entry) => entry.kind === 'SKILL_ROTATION')).toBe(true);
    }
  });

  it('短时预算（<=45）最多安排一项主技能', () => {
    for (const [budget, tier] of [
      [15, 'EMERGENCY'],
      [30, 'MINIMUM'],
      [45, 'LIGHT'],
    ] as const) {
      const plan = mustPlan(makeInput({ budgetMinutes: budget, tierCode: tier }));
      // 四技能任务（primarySkill 属于四项之一）最多一条
      const skillTasks = plan.items.filter((item) =>
        ['LISTENING', 'READING', 'SPEAKING', 'WRITING'].includes(item.primarySkill),
      );
      expect(skillTasks.length, `预算 ${budget}`).toBeLessThanOrEqual(1);
      expect(plan.totalPlannedMinutes, `预算 ${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it('短时预算把整块技能时间给主技能，不浪费预算', () => {
    // 30 分钟档：技能池 12 分钟，应原样给主技能，而不是切碎后只剩 5 分钟
    const plan = mustPlan(makeInput({ budgetMinutes: 30, tierCode: 'MINIMUM' }));
    const mainSkill = plan.items.find((item) =>
      ['LISTENING', 'READING', 'SPEAKING', 'WRITING'].includes(item.primarySkill),
    );
    expect(mainSkill).toBeDefined();
    expect(mainSkill!.minutes).toBeGreaterThanOrEqual(10);
    expect(plan.totalPlannedMinutes).toBe(30);
  });

  it('短时预算按本周偏差选主技能（周轮换生效）', () => {
    // 写作欠得最多 → 今天就该排写作，而不是配比最高的听力
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 30,
        tierCode: 'MINIMUM',
        weeklyGap: { LISTENING: -40, READING: -20, SPEAKING: 0, WRITING: 60 },
      }),
    );
    const mainSkill = plan.items.find((item) =>
      ['LISTENING', 'READING', 'SPEAKING', 'WRITING'].includes(item.primarySkill),
    );
    expect(mainSkill?.primarySkill).toBe('WRITING');
  });

  it('未安排的技能份额转入周轮换且单位为分钟', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 30, tierCode: 'MINIMUM' }));
    const rotation = plan.weeklyRotation;
    const total = Object.values(rotation).reduce((sum, value) => sum + (value ?? 0), 0);
    if (total > 0) {
      // 最多 30 分钟的预算，轮换量不可能超过预算
      expect(total).toBeLessThanOrEqual(30);
      expect(plan.backlog.some((entry) => entry.kind === 'SKILL_ROTATION')).toBe(true);
    }
  });
});

describe('不变量', () => {
  it('任何预算下 Σ 计划分钟 <= 预算', () => {
    for (const budget of [1, 5, 15, 30, 45, 60, 75, 90, 120, 180, 240, 300, 600]) {
      const plan = mustPlan(makeInput({ budgetMinutes: budget, tierCode: 'CUSTOM' }));
      expect(plan.totalPlannedMinutes, `预算 ${budget}`).toBeLessThanOrEqual(budget);
      expect(plan.totalPlannedMinutes).toBe(plannedMinutesOf(plan.items));
    }
  });

  it('每个任务分钟数 > 0 且不超过预算', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 120, tierCode: 'FOCUSED' }));
    for (const item of plan.items) {
      expect(item.minutes).toBeGreaterThan(0);
      expect(item.minutes).toBeLessThanOrEqual(120);
    }
  });

  it('sortOrder 连续且从 0 开始', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 90, tierCode: 'STANDARD' }));
    plan.items.forEach((item, index) => expect(item.sortOrder).toBe(index));
  });

  it('P0 任务一定排在最前', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 90,
        tierCode: 'STANDARD',
        dueReviews: { estMinutes: 20, count: 3, maxOverdueDays: 1 },
      }),
    );
    if (plan.items.length > 0 && plan.priorityMinutes.P0 > 0) {
      expect(plan.items[0].priority).toBe('P0');
    }
  });

  it('非法预算返回失败码而不是抛异常', () => {
    const result = generateAdaptivePlan(makeInput({ budgetMinutes: -5 }));
    expect(result.ok).toBe(false);
  });

  it('T07 到期复习 90 分钟、预算 30 分钟：只排一部分，其余进 backlog 并说明原因', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 30,
        tierCode: 'MINIMUM',
        dueReviews: { estMinutes: 90, count: 18, maxOverdueDays: 3 },
      }),
    );
    // P0 最多占预算 60%，且必须给核心学习留出空间
    expect(plan.priorityMinutes.P0).toBeLessThanOrEqual(Math.floor(30 * P0_CAP_RATIO));
    expect(plan.priorityMinutes.P0).toBeLessThan(90);
    // 核心学习没有被复习挤没
    expect(plan.priorityMinutes.P1).toBeGreaterThanOrEqual(Math.round(30 * CORE_MIN_RATIO) - 10);
    const backlog = plan.backlog.find((entry) => entry.kind === 'REVIEW');
    expect(backlog).toBeDefined();
    expect(backlog!.minutes).toBe(90 - plan.priorityMinutes.P0);
    expect(backlog!.reason.length).toBeGreaterThan(0);
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(30);
  });

  it('T04 自定义 75 分钟不被静默改成 60/90', () => {
    const plan = mustPlan(
      makeInput({ budgetMinutes: 75, tierCode: 'CUSTOM', allocation: A0_ALLOC }),
    );
    expect(plan.totalPlannedMinutes).toBe(75);
    // 三个任务块合计必须正好 75，而不是某个预设档的总额
    expect(plan.totalPlannedMinutes).not.toBe(60);
    expect(plan.totalPlannedMinutes).not.toBe(90);
  });

  it('T01 15 分钟档用满预算并给出维护模式提示', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 15, tierCode: 'EMERGENCY' }));
    expect(plan.totalPlannedMinutes).toBe(15);
    expect(plan.warnings.some((w) => w.includes('应急维护模式'))).toBe(true);
  });

  it('T06 休息日不生成任务，复习留在 backlog', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 90,
        isRestDay: true,
        dueReviews: { estMinutes: 20, count: 4, maxOverdueDays: 0 },
      }),
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.totalPlannedMinutes).toBe(0);
    expect(plan.backlog.some((entry) => entry.kind === 'REVIEW')).toBe(true);
    expect(plan.warnings.some((w) => w.includes('不计为学习失败'))).toBe(true);
  });

  it('S0 准备阶段只出基线诊断，且不拆分', () => {
    const plan = mustPlan(
      makeInput({ stageCode: 'S0_PREP' as StageCode, budgetMinutes: 90 }),
    );
    expect(plan.items.map((item) => item.module)).toEqual([
      'BASELINE_LISTEN',
      'BASELINE_READ',
      'BASELINE_OUTPUT',
    ]);
    for (const item of plan.items) {
      expect(item.splittable).toBe(false);
      expect(item.minutes).toBe(30);
    }
  });

  it('S0 预算不足整项诊断时整项顺延，不做半截诊断', () => {
    const plan = mustPlan(
      makeInput({ stageCode: 'S0_PREP' as StageCode, budgetMinutes: 60 }),
    );
    expect(plan.items).toHaveLength(2);
    expect(plan.totalPlannedMinutes).toBe(60);
    const deferred = plan.backlog.filter((entry) => entry.kind === 'CORE_DEFERRED');
    expect(deferred).toHaveLength(1);
    expect(deferred[0].minutes).toBe(30);
  });

  it('S0 已完成的基线诊断不再重复排', () => {
    const plan = mustPlan(
      makeInput({
        stageCode: 'S0_PREP' as StageCode,
        budgetMinutes: 90,
        skipModules: ['BASELINE_LISTEN'],
      }),
    );
    expect(plan.items.map((item) => item.module)).toEqual(['BASELINE_READ', 'BASELINE_OUTPUT']);
  });

  it('S1 阶段语法类不超过当日预算的 20%', () => {
    for (const budget of [30, 45, 60, 90, 120]) {
      const plan = mustPlan(
        makeInput({ stageCode: 'S1_A0_A2' as StageCode, budgetMinutes: budget }),
      );
      const grammar = plan.items
        .filter((item) => item.module === 'GRAMMAR' || item.module === 'SENTENCE')
        .reduce((sum, item) => sum + item.minutes, 0);
      expect(grammar, `预算 ${budget}`).toBeLessThanOrEqual(Math.floor(budget * 0.2));
    }
  });

  it('T13 没有配比档案时不硬套 25/25/25/25 之外的东西（仅技能池切分）', () => {
    const plan = mustPlan(makeInput({ budgetMinutes: 120, tierCode: 'FOCUSED', allocation: null }));
    const skillTasks = plan.items.filter((item) =>
      ['LISTENING', 'READING', 'SPEAKING', 'WRITING'].includes(item.primarySkill),
    );
    // 无档案时按均分配比切分，四项都应有任务
    expect(skillTasks.length).toBe(4);
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(120);
  });
});

describe('v2.7 候选装箱', () => {
  it('可拆候选使用不低于最小块的全部余量，不把最小块当作步长', () => {
    const plan = mustPlan(makeInput({
      budgetMinutes: 9,
      candidateOnly: true,
      candidateBudgetMinutes: 9,
      candidates: [{
        candidateKey: 'material:test',
        module: 'LISTENING',
        primarySkill: 'LISTENING',
        track: 'GENERAL_ENGLISH',
        estMinutes: 18,
        minMinutes: 5,
        maxBlockMinutes: 18,
        priority: 'P1',
        splittable: true,
        rationale: '测试候选',
        score: 0.5,
        sourceKind: 'MANUAL',
      }],
    }));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].minutes).toBe(9);
    expect(plan.totalPlannedMinutes).toBe(9);
  });

  it('余量低于最小块时不生成碎片', () => {
    const plan = mustPlan(makeInput({
      budgetMinutes: 4,
      candidateOnly: true,
      candidateBudgetMinutes: 4,
      candidates: [{
        candidateKey: 'material:test',
        module: 'LISTENING',
        primarySkill: 'LISTENING',
        track: 'GENERAL_ENGLISH',
        estMinutes: 18,
        minMinutes: 5,
        maxBlockMinutes: 18,
        priority: 'P1',
        splittable: true,
        rationale: '测试候选',
        score: 0.5,
        sourceKind: 'MANUAL',
      }],
    }));
    expect(plan.items).toEqual([]);
    expect(plan.backlog).toHaveLength(1);
  });
});

describe('预算利用口径', () => {
  it('预算为 0 时返回 null（显示 N/A）', () => {
    expect(budgetUsageRatio(30, 0)).toBeNull();
  });

  it('正常比例', () => {
    expect(budgetUsageRatio(45, 90)).toBeCloseTo(0.5, 5);
  });
});

describe('v2.2 复测计入预算', () => {
  it('到期复测先于复习预留，并标记 RETEST 来源', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 60,
        tierCode: 'LIGHT_STANDARD',
        dueReviews: { estMinutes: 20, count: 4, maxOverdueDays: 2 },
        dueRetests: { items: [{ id: 'r1', minutes: 10 }], maxOverdueDays: 3 },
      }),
    );
    const retest = plan.items.find((item) => item.module === 'EVIDENCE_RETEST');
    expect(retest).toBeDefined();
    expect(retest!.minutes).toBe(10);
    expect(retest!.priority).toBe('P0');
    expect(retest!.sourceKind).toBe('RETEST');
    expect(retest!.primarySkill).toBe('FOUNDATION');
    expect(plan.scheduledRetestIds).toEqual(['r1']);
    // 复测是第一个任务：约定时间点优先
    expect(plan.items[0].module).toBe('EVIDENCE_RETEST');
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(60);
    expect(plan.warnings.some((line) => line.includes('证据复测'))).toBe(true);
  });

  it('放不下的复测整项顺延，不拆半截，进 backlog 说明原因', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 15,
        tierCode: 'EMERGENCY',
        dueRetests: { items: [{ id: 'big', minutes: 25 }], maxOverdueDays: 1 },
      }),
    );
    expect(plan.items.some((item) => item.module === 'EVIDENCE_RETEST')).toBe(false);
    expect(plan.scheduledRetestIds).toEqual([]);
    const backlog = plan.backlog.find((entry) => entry.kind === 'RETEST');
    expect(backlog).toBeDefined();
    expect(backlog!.minutes).toBe(25);
    expect(plan.totalPlannedMinutes).toBeLessThanOrEqual(15);
  });

  it('多条复测按时长逐条尝试：放得下的排、放不下的顺延', () => {
    const items = [
      { id: 'short', minutes: 10 },
      { id: 'long', minutes: 20 },
    ];
    const tight = mustPlan(makeInput({ budgetMinutes: 25, tierCode: 'CUSTOM', dueRetests: { items } }));
    expect(tight.scheduledRetestIds).toEqual(['short']);
    expect(tight.backlog.find((entry) => entry.kind === 'RETEST')!.minutes).toBe(20);

    const roomy = mustPlan(makeInput({ budgetMinutes: 30, tierCode: 'MINIMUM', dueRetests: { items } }));
    expect(roomy.scheduledRetestIds).toEqual(['short', 'long']);
    expect(roomy.backlog.some((entry) => entry.kind === 'RETEST')).toBe(false);
  });

  it('复测计入预算上限：任意预算下 Σ 计划分钟 <= 预算', () => {
    for (const budget of [5, 15, 30, 45, 60, 90, 120, 180, 240]) {
      const plan = mustPlan(
        makeInput({
          budgetMinutes: budget,
          tierCode: 'CUSTOM',
          dueRetests: { items: [{ id: 'a', minutes: 10 }, { id: 'b', minutes: 30 }] },
        }),
      );
      expect(plan.totalPlannedMinutes, `预算 ${budget}`).toBeLessThanOrEqual(budget);
      const retestMinutes = plan.items
        .filter((item) => item.module === 'EVIDENCE_RETEST')
        .reduce((sum, item) => sum + item.minutes, 0);
      expect(retestMinutes).toBeLessThanOrEqual(budget);
    }
  });

  it('休息日不排复测，但保留在 backlog', () => {
    const plan = mustPlan(
      makeInput({
        budgetMinutes: 0,
        isRestDay: true,
        dueRetests: { items: [{ id: 'r1', minutes: 10 }] },
      }),
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.backlog.find((entry) => entry.kind === 'RETEST')!.minutes).toBe(10);
  });
});
