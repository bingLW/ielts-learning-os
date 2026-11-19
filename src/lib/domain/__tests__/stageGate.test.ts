/**
 * 被测文件：src/lib/domain/stageGate.ts
 * 规则来源：PRD §6.4（H1 必验项全部 PASSED；H2 每个 PASSED 必须有结果+证据+阶段内判定日期；
 *           H3 近 14 天 D7/D14 完成率 ≥80%；H4 近 30 天有计划的日期中净时长 ≥240min 占比 ≥80%；
 *           H5 无未处理红灯）。只返回建议，永不自动升级。
 */

import { describe, expect, it } from 'vitest';
import { evaluateStageGate } from '../stageGate';
import type { GateInput } from '../stageGate';
import {
  GATE_H3_MIN_RATE,
  GATE_H3_WINDOW_DAYS,
  GATE_H4_MIN_MINUTES,
  GATE_H4_MIN_RATE,
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

/** 最近 n 天，每天都有计划且净时长达标。 */
function fullDays(n: number): GateInput['days'] {
  return Array.from({ length: n }, (_, index) => ({
    date: addDays(TODAY, -(n - 1 - index)),
    hasPlan: true,
    netMinutes: GATE_H4_MIN_MINUTES,
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
    expect(GATE_H4_MIN_MINUTES, 'H4 单日门槛 240 分钟').toBe(240);
    expect(GATE_H4_MIN_RATE, 'H4 达标占比门槛 80%').toBe(0.8);
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
    expect(result.metrics.h4Rate as number, '30 天全部达标 → 100%').toBeCloseTo(1, 5);
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
    expect(result.metrics.h4Rate as number, 'H4 确实是 100%').toBeCloseTo(1, 5);
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

describe('evaluateStageGate —— H4 近 30 天达标天数占比', () => {
  it('20/30 达标（67%）→ unmet 含 H4', () => {
    const days = Array.from({ length: 30 }, (_, index) => ({
      date: addDays(TODAY, -(29 - index)),
      hasPlan: true,
      netMinutes: index < 10 ? 100 : 240,
    }));
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4Rate as number, '20/30').toBeCloseTo(20 / 30, 5);
    expect(unmetCodes(result)).toContain('H4');
    const h4 = result.unmet.find((item) => item.code === 'H4');
    expect(h4?.current, '现值 67%').toBe('67%');
  });

  it('单日门槛 240 分钟：239 不算达标、240 算达标', () => {
    const days = [
      ...Array.from({ length: 7 }, (_, index) => ({
        date: addDays(TODAY, -(index + 1)),
        hasPlan: true,
        netMinutes: 240,
      })),
      { date: TODAY, hasPlan: true, netMinutes: 239 },
      { date: addDays(TODAY, -10), hasPlan: true, netMinutes: 240 },
      { date: addDays(TODAY, -11), hasPlan: true, netMinutes: 240 },
    ];
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4Rate as number, '9/10 达标（239 那天不达标）').toBeCloseTo(0.9, 5);
    expect(unmetCodes(result), '90% ≥ 80% 不应报 H4').not.toContain('H4');
  });

  it('没有计划的日期不进分母', () => {
    const days = [
      { date: TODAY, hasPlan: true, netMinutes: 240 },
      { date: addDays(TODAY, -1), hasPlan: false, netMinutes: 0 },
      { date: addDays(TODAY, -2), hasPlan: false, netMinutes: 0 },
    ];
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4Rate as number, '只统计有计划的日期 → 1/1').toBeCloseTo(1, 5);
  });

  it('近 30 天完全没有带计划的日期 → H4 无数据即未满足', () => {
    const result = evaluateStageGate(makeInput({ days: [] }));
    expect(result.metrics.h4Rate).toBeNull();
    expect(unmetCodes(result)).toContain('H4');
  });

  it('窗口外的日期不计入', () => {
    const days = [
      { date: TODAY, hasPlan: true, netMinutes: 240 },
      { date: addDays(TODAY, -(GATE_H4_WINDOW_DAYS + 1)), hasPlan: true, netMinutes: 0 },
    ];
    const result = evaluateStageGate(makeInput({ days }));
    expect(result.metrics.h4Rate as number, '30 天窗口外的坏日子不该拉低占比').toBeCloseTo(1, 5);
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
    expect(unmetCodes(result), '五项差距都要列出来，不能只报第一条').toEqual([
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
    ]);
    expect(
      result.unmet.every((item) => item.target.length > 0 && item.label.length > 0),
      '每条差距都必须有 label 与 target，UI 才能直接展示',
    ).toBe(true);
  });
});
