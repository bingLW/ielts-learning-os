/**
 * 被测文件：src/lib/domain/stageGate.ts
 *
 * 规则来源：PRD §6.4 + **v2.7 Q5 改造**：
 * - 判定项（进 `suggested`）：H1 必验项全部 PASSED；H2 每个 PASSED 有结果+证据+阶段内
 *   判定日期；H3 近 14 天 D7/D14 完成率 ≥80%；H5 无未处理红灯；
 * - **H4「投入稳定性」退出判定**，只作为参考指标出现在 `metrics.h4`
 *   （相对预算口径 rate + 旧 240 分钟口径 legacyRate）。
 *
 * 这组用例守的是「H4 不能再拦人」：任何把 H4 塞回 blockers 的改动都必须在这里失败。
 */

import { describe, expect, it } from 'vitest';
import { evaluateStageGate } from '../stageGate';
import type { GateInput } from '../stageGate';
import {
  GATE_H3_MIN_RATE,
  GATE_H3_WINDOW_DAYS,
  GATE_H4_LEGACY_MIN_MINUTES,
  GATE_H4_MIN_BUDGET_MINUTES,
  GATE_H4_MIN_MINUTES,
  GATE_H4_MIN_RATE,
  GATE_H4_MIN_RATIO,
  GATE_H4_WINDOW_DAYS,
  REQUIRED_DIMENSIONS,
} from '../../constants';
import { addDays } from '../../date';
import type { EgiuColor, IntervalCode, ReviewStatus, Verdict } from '../../types';

const TODAY = '2025-06-30';
const STAGE_START = '2025-05-01';

/** 一个通过项（默认证据齐全、判定日期在阶段内）。 */
function passedItem(
  dimension: string,
  over: Partial<GateInput['acceptance'][number]> = {},
): GateInput['acceptance'][number] {
  return {
    dimension,
    isRequired: true,
    verdict: 'PASSED' as Verdict,
    myResult: '正确率 88%',
    evidence: '模考记录 #12',
    judgedAt: '2025-06-10',
    ...over,
  };
}

/** 五个必验维度各一个通过项。 */
function allRequiredPassed(): GateInput['acceptance'] {
  return REQUIRED_DIMENSIONS.map((dimension) => passedItem(dimension));
}

/** H4 用例的默认日预算（≥ GATE_H4_MIN_BUDGET_MINUTES 才进分母）。 */
const BUDGET = 60;

/** 最近 n 天，每天都有计划、预算 60 分钟、净学满 60 分钟（相对口径 100%）。 */
function fullDays(n: number): GateInput['days'] {
  return Array.from({ length: n }, (_, index) => ({
    date: addDays(TODAY, -(n - 1 - index)),
    hasPlan: true,
    netMinutes: BUDGET,
    budgetMinutes: BUDGET,
  }));
}

function reviewTask(
  intervalCode: IntervalCode,
  status: ReviewStatus,
  dueDate: string,
): GateInput['reviewTasks'][number] {
  return { intervalCode, status, dueDate, result: status === 'DONE' ? 'PASS' : null };
}

/** 一份「全部达标」的基线输入。 */
function makeInput(over: Partial<GateInput> = {}): GateInput {
  return {
    stageStart: STAGE_START,
    stageEnd: null,
    today: TODAY,
    acceptance: allRequiredPassed(),
    reviewTasks: [
      reviewTask('D7', 'DONE', addDays(TODAY, -7)),
      reviewTask('D14', 'DONE', addDays(TODAY, -3)),
    ],
    days: fullDays(GATE_H4_WINDOW_DAYS),
    lessons: [{ currentColor: 'GREEN' as EgiuColor }],
    ...over,
  };
}

function unmetCodes(result: ReturnType<typeof evaluateStageGate>): string[] {
  return result.unmet.map((item) => item.code);
}

describe('阈值常量', () => {
  it('门禁阈值符合 PRD §6.4', () => {
    expect(GATE_H3_WINDOW_DAYS, 'H3 窗口 14 天').toBe(14);
    expect(GATE_H3_MIN_RATE, 'H3 完成率门槛 80%').toBe(0.8);
    expect(GATE_H4_WINDOW_DAYS, 'H4 窗口 30 天').toBe(30);
    expect(GATE_H4_MIN_RATIO, 'H4 相对预算口径：预算的 60%').toBe(0.6);
    expect(GATE_H4_MIN_BUDGET_MINUTES, 'H4 分母下限 15 分钟').toBe(15);
    expect(GATE_H4_LEGACY_MIN_MINUTES, '旧口径 240 分钟只作参考').toBe(240);
    expect(GATE_H4_MIN_MINUTES, '@deprecated 别名仍指向 240（不得用于判定）').toBe(240);
    expect(GATE_H4_MIN_RATE, 'H4 达标占比参考线 80%（不进判定）').toBe(0.8);
    expect(REQUIRED_DIMENSIONS, 'H1 必验维度：听说读写语法').toEqual([
      'LISTENING',
      'READING',
      'SPEAKING',
      'WRITING',
      'GRAMMAR',
    ]);
  });
});

describe('evaluateStageGate —— 全部达标', () => {
  it('H1–H5 全满足 → suggested=true 且 unmet 为空', () => {
    const result = evaluateStageGate(makeInput());
    expect(result.unmet, '全部达标时不应有任何未满足项').toEqual([]);
    expect(result.suggested, '建议升级按钮应可用').toBe(true);
    expect(result.metrics.requiredTotal, '必验维度共 5 个').toBe(5);
    expect(result.metrics.requiredPassed, '5 个必验维度全部通过').toBe(5);
    expect(result.metrics.h3Rate as number, 'D7/D14 全部完成 → 100%').toBeCloseTo(1, 5);
    expect(result.metrics.h4.rate as number, '30 天全部达标 → 100%').toBeCloseTo(1, 5);
    expect(result.metrics.redLessons).toBe(0);
  });
});

describe('evaluateStageGate —— H1 必验项', () => {
  it('缺一个必验维度 → suggested=false 且 unmet 含 H1', () => {
    const acceptance = allRequiredPassed().filter((item) => item.dimension !== 'GRAMMAR');
    const result = evaluateStageGate(makeInput({ acceptance }));
    expect(result.suggested, '语法必验项缺失，不能建议升级').toBe(false);
    expect(unmetCodes(result), '未达标项必须出现在 unmet 里').toContain('H1');
    expect(result.metrics.requiredPassed, '通过 4/5').toBe(4);
  });

  it('必验项只判 FAILED → 不算通过', () => {
    const acceptance = REQUIRED_DIMENSIONS.map((dimension) =>
      passedItem(dimension, { verdict: dimension === 'SPEAKING' ? 'FAILED' : 'PASSED' }),
    );
    const result = evaluateStageGate(makeInput({ acceptance }));
    expect(result.suggested, '口语未通过不能升级').toBe(false);
    expect(unmetCodes(result)).toContain('H1');
  });

  it('必验项仍是 PENDING → 不算通过', () => {
    const acceptance = REQUIRED_DIMENSIONS.map((dimension) =>
      passedItem(dimension, { verdict: dimension === 'READING' ? 'PENDING' : 'PASSED' }),
    );
    const result = evaluateStageGate(makeInput({ acceptance }));
    expect(result.suggested, '待判定的必验项不能算通过').toBe(false);
    expect(unmetCodes(result)).toContain('H1');
  });

  it('「学习天数够」不能单独把门禁打开', () => {
    // 30 天全部达标（H4 满分）、D7/D14 全完成（H3 满分），但必验项只过了听力
    const result = evaluateStageGate(
      makeInput({
        acceptance: [passedItem('LISTENING')],
        days: fullDays(30),
      }),
    );
    expect(result.metrics.h4.rate as number, 'H4 确实是 100%').toBeCloseTo(1, 5);
    expect(result.metrics.h3Rate as number, 'H3 确实是 100%').toBeCloseTo(1, 5);
    expect(result.suggested, '学习量达标不等于验收达标，门禁必须保持关闭').toBe(false);
    expect(unmetCodes(result), '必须列出 H1 差距').toContain('H1');
  });

  it('非必验维度（VOCAB / SENTENCE）不过不阻塞升级', () => {
    const acceptance = [
      ...allRequiredPassed(),
      passedItem('VOCAB', { verdict: 'FAILED' }),
      passedItem('SENTENCE', { verdict: 'PENDING' }),
    ];
    const result = evaluateStageGate(makeInput({ acceptance }));
    expect(result.suggested, 'VOCAB/SENTENCE 不是 H1 必验维度').toBe(true);
  });
});

describe('evaluateStageGate —— H2 证据完整性', () => {
  it('通过项缺证据 → unmet 含 H2', () => {
    const acceptance = allRequiredPassed().map((item) =>
      item.dimension === 'WRITING' ? { ...item, evidence: '   ' } : item,
    );
    const result = evaluateStageGate(makeInput({ acceptance }));
    expect(result.suggested, '证据缺失不能升级').toBe(false);
    expect(unmetCodes(result), '必须报 H2').toContain('H2');
  });

  it('通过项缺「我的实际结果」→ unmet 含 H2', () => {
    const acceptance = allRequiredPassed().map((item) =>
      item.dimension === 'LISTENING' ? { ...item, myResult: null } : item,
    );
    const result = evaluateStageGate(makeInput({ acceptance }));
    expect(result.suggested, '缺实际结果不能升级').toBe(false);
    expect(unmetCodes(result)).toContain('H2');
  });

  it('通过项缺判定日期 → unmet 含 H2', () => {
    const acceptance = allRequiredPassed().map((item) =>
      item.dimension === 'READING' ? { ...item, judgedAt: null } : item,
    );
    const result = evaluateStageGate(makeInput({ acceptance }));
    expect(result.suggested, '缺判定日期不能升级').toBe(false);
    expect(unmetCodes(result)).toContain('H2');
  });

  it('判定日期早于阶段开始 → unmet 含 H2', () => {
    const acceptance = allRequiredPassed().map((item) =>
      item.dimension === 'GRAMMAR' ? { ...item, judgedAt: '2025-04-30' } : item,
    );
    const result = evaluateStageGate(makeInput({ acceptance }));
    expect(result.suggested, '阶段外的判定不能算本阶段成果').toBe(false);
    expect(unmetCodes(result)).toContain('H2');
  });

  it('阶段已结束且判定日期晚于阶段结束 → unmet 含 H2', () => {
    const acceptance = allRequiredPassed().map((item) =>
      item.dimension === 'GRAMMAR' ? { ...item, judgedAt: '2025-07-20' } : item,
    );
    const result = evaluateStageGate(
      makeInput({ acceptance, stageStart: STAGE_START, stageEnd: '2025-06-30' }),
    );
    expect(result.suggested, '超阶段的判定不能算本阶段成果').toBe(false);
    expect(unmetCodes(result)).toContain('H2');
  });
});

describe('evaluateStageGate —— H3 近 14 天 D7/D14 完成率', () => {
  it('3/4 = 75% < 80% → unmet 含 H3 且给出现值', () => {
    const reviewTasks = [
      reviewTask('D7', 'DONE', addDays(TODAY, -1)),
      reviewTask('D7', 'DONE', addDays(TODAY, -2)),
      reviewTask('D14', 'DONE', addDays(TODAY, -3)),
      reviewTask('D14', 'PENDING', addDays(TODAY, -4)),
    ];
    const result = evaluateStageGate(makeInput({ reviewTasks }));
    expect(result.suggested).toBe(false);
    expect(unmetCodes(result)).toContain('H3');
    expect(result.metrics.h3Rate as number, '3/4').toBeCloseTo(0.75, 5);
    const h3 = result.unmet.find((item) => item.code === 'H3');
    expect(h3?.current, '必须把现值 75% 写给用户看').toBe('75%');
  });

  it('4/5 = 80% 恰好达标 → 不报 H3', () => {
    const reviewTasks = [
      reviewTask('D7', 'DONE', addDays(TODAY, -1)),
      reviewTask('D7', 'DONE', addDays(TODAY, -2)),
      reviewTask('D7', 'DONE', addDays(TODAY, -3)),
      reviewTask('D14', 'DONE', addDays(TODAY, -4)),
      reviewTask('D14', 'SKIPPED', addDays(TODAY, -5)),
    ];
    const result = evaluateStageGate(makeInput({ reviewTasks }));
    expect(result.metrics.h3Rate as number, '4/5 = 0.8，含边界通过').toBeCloseTo(0.8, 5);
    expect(unmetCodes(result), '80% 达标不应报 H3').not.toContain('H3');
  });

  it('没有任何 D7/D14 记录 → H3 视为未满足（分母 0 不等于达标）', () => {
    const result = evaluateStageGate(makeInput({ reviewTasks: [] }));
    expect(result.metrics.h3Rate, '无数据 → null').toBeNull();
    expect(result.suggested, '没有证据不能升级').toBe(false);
    expect(unmetCodes(result)).toContain('H3');
    const h3 = result.unmet.find((item) => item.code === 'H3');
    expect(h3?.current.includes('无数据'), '文案必须说明是无数据').toBe(true);
  });

  it('只有 D1/D3 记录 → 不计入 H3', () => {
    const reviewTasks = [
      reviewTask('D1', 'DONE', addDays(TODAY, -1)),
      reviewTask('D3', 'PENDING', addDays(TODAY, -2)),
    ];
    const result = evaluateStageGate(makeInput({ reviewTasks }));
    expect(result.metrics.h3Rate, 'H3 只统计 D7/D14').toBeNull();
  });

  it('未来到期的 D7/D14 不计入分母', () => {
    const reviewTasks = [
      reviewTask('D7', 'DONE', addDays(TODAY, -1)),
      reviewTask('D14', 'PENDING', addDays(TODAY, 1)),
    ];
    const result = evaluateStageGate(makeInput({ reviewTasks }));
    expect(result.metrics.h3Rate as number, '只算今天及以前到期的点 → 1/1').toBeCloseTo(1, 5);
  });

  it('窗口外的老记录不计入分母', () => {
    const reviewTasks = [
      reviewTask('D7', 'DONE', addDays(TODAY, -1)),
      reviewTask('D7', 'PENDING', addDays(TODAY, -(GATE_H3_WINDOW_DAYS + 1))),
    ];
    const result = evaluateStageGate(makeInput({ reviewTasks }));
    expect(result.metrics.h3Rate as number, '14 天窗口外的任务不参与统计').toBeCloseTo(1, 5);
  });
});

describe('evaluateStageGate —— H4 投入稳定性（参考，不参与判定）', () => {
  it('20/30 达标（67%）→ 只体现在 metrics.h4，不再产生 blocker', () => {
    const days = Array.from({ length: 30 }, (_, index) => ({
      date: addDays(TODAY, -(29 - index)),
      hasPlan: true,
      // 相对口径：前 10 天只学了预算的一半（不达标），后 20 天学满
      netMinutes: index < 10 ? Math.floor(BUDGET / 2) : BUDGET,
      budgetMinutes: BUDGET,
    }));
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4.rate as number, '20/30').toBeCloseTo(20 / 30, 5);
    expect(
      unmetCodes(result),
      'H4 已退出判定：占比不达标也不得出现在 unmet 里',
    ).not.toContain('H4');
    expect(result.suggested, '其余判定项都达标 → 仍然建议升级').toBe(true);
  });

  it('相对预算口径：239/240 分钟算达标（旧口径不算）', () => {
    const days = [
      ...Array.from({ length: 7 }, (_, index) => ({
        date: addDays(TODAY, -(index + 1)),
        hasPlan: true,
        netMinutes: 240,
        budgetMinutes: 240,
      })),
      { date: TODAY, hasPlan: true, netMinutes: 239, budgetMinutes: 240 },
    ];
    const result = evaluateStageGate(makeInput({ days }));
    // 239 / 240 = 99.6% ≥ 60% → 相对口径达标
    expect(result.metrics.h4.qualifiedDays, '8 天全部达标').toBe(8);
    expect(result.metrics.h4.rate as number).toBeCloseTo(1, 5);
    // 旧口径只认 ≥240，所以 239 那天不算
    expect(result.metrics.h4.legacyRate as number, '旧口径 7/8').toBeCloseTo(7 / 8, 5);
    expect(unmetCodes(result)).not.toContain('H4');
  });

  it('没有计划的日期不进分母', () => {
    const days = [
      { date: TODAY, hasPlan: true, netMinutes: BUDGET, budgetMinutes: BUDGET },
      { date: addDays(TODAY, -1), hasPlan: false, netMinutes: 0, budgetMinutes: BUDGET },
      { date: addDays(TODAY, -2), hasPlan: false, netMinutes: 0, budgetMinutes: BUDGET },
    ];
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4.eligibleDays, '只统计有计划的日期 → 1').toBe(1);
    expect(result.metrics.h4.rate as number, '1/1').toBeCloseTo(1, 5);
  });

  it('近 30 天完全没有可比的日期 → rate 为 null（不是 0），且不产生 blocker', () => {
    const result = evaluateStageGate(makeInput({ days: [] }));
    expect(result.metrics.h4.rate, '无样本 → null，UI 显示「—」').toBeNull();
    expect(result.metrics.h4.legacyRate, '旧口径同样无样本').toBeNull();
    expect(unmetCodes(result)).not.toContain('H4');
    expect(result.suggested, '没有可比样本不再阻断升级').toBe(true);
  });

  it('窗口外的日期不计入', () => {
    const days = [
      { date: TODAY, hasPlan: true, netMinutes: BUDGET, budgetMinutes: BUDGET },
      {
        date: addDays(TODAY, -(GATE_H4_WINDOW_DAYS + 1)),
        hasPlan: true,
        netMinutes: 0,
        budgetMinutes: BUDGET,
      },
    ];
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4.eligibleDays, '30 天窗口外的坏日子既不进分母也不进分子').toBe(1);
    expect(result.metrics.h4.rate as number).toBeCloseTo(1, 5);
  });
});

describe('evaluateStageGate —— H4 改造的 5 条硬要求（v2.7 Q5）', () => {
  it('① 30 分钟预算、20 个达标日（净 20 分钟）→ blockers 里没有 H4，passed 不受影响', () => {
    // 净 20 分钟 = 预算 30 的 67% ≥ 60% → 每一天都"达标"
    const days = Array.from({ length: 20 }, (_, index) => ({
      date: addDays(TODAY, -(index + 1)),
      hasPlan: true,
      netMinutes: 20,
      budgetMinutes: 30,
    }));
    const result = evaluateStageGate(makeInput({ days }));

    expect(result.metrics.h4.eligibleDays, '20 天全部进分母').toBe(20);
    expect(result.metrics.h4.qualifiedDays, '20 天全部达标').toBe(20);
    expect(result.metrics.h4.rate as number, '20/20 = 100%').toBeCloseTo(1, 5);
    expect(unmetCodes(result), 'H4 不得产生 blocker').not.toContain('H4');
    expect(result.suggested, 'H4 不再影响 passed').toBe(true);
  });

  it('② eligibleDays = 0 → h4.rate 必须是 null，不是 0', () => {
    // 只有「没计划」的日期：分母恒为 0
    const days = Array.from({ length: 5 }, (_, index) => ({
      date: addDays(TODAY, -(index + 1)),
      hasPlan: false,
      netMinutes: 0,
      budgetMinutes: BUDGET,
    }));
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4.eligibleDays).toBe(0);
    expect(result.metrics.h4.rate).toBeNull();
    // 关键区分：null ≠ 0。写成 0 会被 UI 渲染成「0%」，等于说用户一天都没达标
    expect(result.metrics.h4.rate).not.toBe(0);
  });

  it('③ 预算 10 分钟的日期既不进分母，也不算「缺预算」', () => {
    const days = [
      { date: TODAY, hasPlan: true, netMinutes: BUDGET, budgetMinutes: BUDGET },
      // 10 < GATE_H4_MIN_BUDGET_MINUTES(15)：有预算，只是没有可比性
      { date: addDays(TODAY, -1), hasPlan: true, netMinutes: 10, budgetMinutes: 10 },
      { date: addDays(TODAY, -2), hasPlan: true, netMinutes: 5, budgetMinutes: 5 },
    ];
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4.eligibleDays, '只有预算 60 的那天进分母').toBe(1);
    expect(result.metrics.h4.missingBudgetDays, '这是设计取舍，不是数据缺口 → 不计数').toBe(0);
    expect(result.metrics.h4.rate as number).toBeCloseTo(1, 5);
  });

  it('④ 某日没有预算信息 → 进 missingBudgetDays，不进分母', () => {
    const days = [
      { date: TODAY, hasPlan: true, netMinutes: BUDGET, budgetMinutes: BUDGET },
      // NaN = "拿不到预算信息"（调用方疏漏 / 历史数据缺口）
      { date: addDays(TODAY, -1), hasPlan: true, netMinutes: 999, budgetMinutes: Number.NaN },
    ];
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4.missingBudgetDays, '缺预算的日子单独计数').toBe(1);
    expect(result.metrics.h4.eligibleDays, '缺预算不进分母（否则它会变成"达标"的天）').toBe(1);
    expect(result.metrics.h4.qualifiedDays).toBe(1);
  });

  it('⑤ legacyRate 用 240 分钟口径算同一批 eligible 日，且改变它不影响 passed', () => {
    const days = Array.from({ length: 10 }, (_, index) => ({
      date: addDays(TODAY, -(index + 1)),
      hasPlan: true,
      netMinutes: BUDGET,
      budgetMinutes: BUDGET,
    }));
    const lowLegacy = evaluateStageGate(makeInput({ days }));
    expect(lowLegacy.metrics.h4.legacyRate as number, '60 分钟远不到 240 → 0%').toBeCloseTo(0, 5);
    expect(lowLegacy.metrics.h4.eligibleDays, '两个口径共用同一批 eligible 日').toBe(10);
    expect(lowLegacy.metrics.h4.rate as number, '相对口径是 100%').toBeCloseTo(1, 5);
    expect(lowLegacy.suggested, '旧口径 0% 也不影响结论').toBe(true);

    // 把同一批日期改成"学满 240 分钟"：legacyRate 变 100%，但结论一样（说明它不参与判定）
    const highLegacy = evaluateStageGate(
      makeInput({
        days: days.map((day) => ({ ...day, netMinutes: GATE_H4_LEGACY_MIN_MINUTES })),
      }),
    );
    expect(highLegacy.metrics.h4.legacyRate as number).toBeCloseTo(1, 5);
    expect(highLegacy.suggested).toBe(true);
    expect(highLegacy.unmet.map((item) => item.code)).toEqual(lowLegacy.unmet.map((item) => item.code));
  });
});

describe('evaluateStageGate —— H5 红灯', () => {
  it('存在红灯单元 → unmet 含 H5', () => {
    const result = evaluateStageGate(
      makeInput({ lessons: [{ currentColor: 'GREEN' }, { currentColor: 'RED' }] }),
    );
    expect(result.suggested, '有红灯不能升级').toBe(false);
    expect(unmetCodes(result)).toContain('H5');
    expect(result.metrics.redLessons, '红灯计数 1').toBe(1);
  });

  it('只有黄灯/待判定 → 不阻塞升级', () => {
    const result = evaluateStageGate(
      makeInput({ lessons: [{ currentColor: 'YELLOW' }, { currentColor: 'PENDING' }] }),
    );
    expect(result.suggested, '黄灯和待判定不阻塞升级').toBe(true);
  });
});

describe('evaluateStageGate —— 多项同时未达标', () => {
  it('所有项都不达标 → unmet 含 H1–H5 五项', () => {
    const result = evaluateStageGate({
      stageStart: STAGE_START,
      stageEnd: null,
      today: TODAY,
      // 必验项一个都没过（H1），且有一个通过项证据全无（H2）
      acceptance: [
        {
          dimension: 'VOCAB',
          isRequired: false,
          verdict: 'PASSED',
          myResult: null,
          evidence: null,
          judgedAt: null,
        },
      ],
      reviewTasks: [],
      days: [],
      lessons: [{ currentColor: 'RED' }],
    });
    expect(result.suggested).toBe(false);
    // H4 已于 v2.7 退出判定 → 这里只剩 4 个 blocker（H4 仍在 metrics.h4 里可见）
    expect(unmetCodes(result), '所有阻断项都要列出来，不能只报第一条').toEqual([
      'H1',
      'H2',
      'H3',
      'H5',
    ]);
    expect(
      result.unmet.some((item) => item.code === 'H4'),
      'H4 是参考指标，绝不允许回到 blockers',
    ).toBe(false);
    expect(
      result.unmet.every((item) => item.target.length > 0 && item.label.length > 0),
      '每条差距都必须有 label 与 target，UI 才能直接展示',
    ).toBe(true);
  });
});
