/**
 * 被测文件：src/lib/domain/duration.ts（+ 复用的 src/lib/date.ts splitAcrossMidnight）
 * 规则来源：PRD §6.6 / §6.3 边界 6（单段实际 ≤ 计划×1.5；实际 < max(3min, 计划×20%) 记 0；
 *           相邻计时段间隔 >30min 计入 idle 不计 active；休息不计入；跨零点按分钟占比拆分，
 *           Σminutes === activeMinutes）。
 */

import { describe, expect, it } from 'vitest';
import {
  IDLE_GAP_MINUTES,
  clampCountRatio,
  deriveActiveMinutes,
  isReviewLoadHeavy,
  netMinutesByDate,
  sessionNet,
  skillMinutes,
  splitAcrossMidnight,
  sumMinutes,
} from '../duration';
import {
  IDLE_GAP_MINUTES as IDLE_FROM_CONSTANTS,
  NET_ABSOLUTE_MAX_MINUTES,
  NET_MAX_RATIO,
  NET_MIN_MINUTES,
  NET_MIN_RATIO,
} from '../../constants';

const session = (over: Partial<Parameters<typeof sessionNet>[0]> = {}) => ({
  activeMinutes: 40,
  plannedMinutes: 45,
  startedAt: '2020-01-01T01:00:00.000Z',
  endedAt: '2020-01-01T01:40:00.000Z',
  idleMinutes: 0,
  ...over,
});

describe('阈值常量', () => {
  it('误触与挂机阈值符合 PRD §6.6', () => {
    expect(NET_MIN_MINUTES, '误触下限 3 分钟').toBe(3);
    expect(NET_MIN_RATIO, '误触比例 20%').toBe(0.2);
    expect(NET_MAX_RATIO, '挂机截断上限 1.5 倍').toBe(1.5);
    expect(IDLE_GAP_MINUTES, 'idle 判定间隔 30 分钟').toBe(30);
    expect(IDLE_GAP_MINUTES, 'duration 重导出必须与 constants 同一个值').toBe(IDLE_FROM_CONSTANTS);
  });
});

describe('splitAcrossMidnight —— 跨零点按分钟占比拆分', () => {
  it('23:30 起 60 分钟 → 两天各 30 分钟，合计不变', () => {
    // 2025-03-01 23:30 (+08:00) = 2025-03-01T15:30:00Z
    const splits = splitAcrossMidnight('2025-03-01T15:30:00.000Z', 60);
    expect(
      splits.map((split) => split.date),
      '跨零点必须拆成两个自然日',
    ).toEqual(['2025-03-01', '2025-03-02']);
    expect(
      splits.map((split) => split.minutes),
      '距离日切 30 分钟 → 各 30 分钟',
    ).toEqual([30, 30]);
    expect(sumMinutes(splits.map((split) => split.minutes)), 'Σ 必须等于总分钟 60').toBe(60);
  });

  it('23:00 起 150 分钟 → 首日 60、次日 90，合计 150', () => {
    const splits = splitAcrossMidnight('2025-03-01T15:00:00.000Z', 150);
    expect(splits, '首日只能吃掉日切前剩余 60 分钟').toEqual([
      { date: '2025-03-01', minutes: 60 },
      { date: '2025-03-02', minutes: 90 },
    ]);
    expect(sumMinutes(splits.map((split) => split.minutes)), '拆分不得丢分钟').toBe(150);
  });

  it('23:45 起 15 分钟 → 不跨日，只落在当天', () => {
    const splits = splitAcrossMidnight('2025-03-01T15:45:00.000Z', 15);
    expect(splits, '15 分钟在日切前结束，不应拆到次日').toEqual([
      { date: '2025-03-01', minutes: 15 },
    ]);
  });

  it('0 分钟 → 返回当天 0 分钟，不返回空数组', () => {
    const splits = splitAcrossMidnight('2025-03-01T02:00:00.000Z', 0);
    expect(splits, '0 分钟也应给出日期归属而不是空数组').toEqual([
      { date: '2025-03-01', minutes: 0 },
    ]);
  });

  it('负数分钟被夹到 0', () => {
    const splits = splitAcrossMidnight('2025-03-01T02:00:00.000Z', -30);
    expect(sumMinutes(splits.map((split) => split.minutes)), '负时长按 0 处理').toBe(0);
  });

  it('netMinutesByDate 按日期聚合并求和', () => {
    const byDate = netMinutesByDate([
      { date: '2025-03-01', minutes: 30 },
      { date: '2025-03-02', minutes: 30 },
      { date: '2025-03-01', minutes: 15 },
    ]);
    expect(byDate, '同一天的多个 split 要相加').toEqual({
      '2025-03-01': 45,
      '2025-03-02': 30,
    });
  });
});

describe('sessionNet —— 误触与挂机截断', () => {
  it('低于 max(3, 计划×20%) 判误触记 0：45min 计划下 8 分钟记 0', () => {
    const result = sessionNet(session({ activeMinutes: 8, plannedMinutes: 45 }));
    expect(result.netMinutes, '8 < 9（45×20%），视为误触记 0').toBe(0);
    expect(result.anomaly, '误触必须标 anomaly').toBe(true);
  });

  it('恰好到达阈值不记误触：45min 计划下 9 分钟有效（边界含等号）', () => {
    const result = sessionNet(session({ activeMinutes: 9, plannedMinutes: 45 }));
    expect(result.netMinutes, '9 = 45×20%，不应被判误触').toBe(9);
    expect(result.anomaly).toBe(false);
  });

  it('超过计划 1.5 倍 → 截断到 1.5 倍并标异常', () => {
    const result = sessionNet(session({ activeMinutes: 61, plannedMinutes: 40 }));
    expect(result.netMinutes, '40×1.5 = 60，61 分钟截断为 60').toBe(60);
    expect(result.anomaly, '挂机必须标 anomaly').toBe(true);
  });

  it('恰好 1.5 倍不截断（边界含等号）', () => {
    const result = sessionNet(session({ activeMinutes: 60, plannedMinutes: 40 }));
    expect(result.netMinutes, '60 = 40×1.5，不触发截断').toBe(60);
    expect(result.anomaly).toBe(false);
  });

  it('D10：计划为 0 时按绝对上限 180 分钟截断，不得原样入库', () => {
    const result = sessionNet(session({ activeMinutes: 500, plannedMinutes: 0 }));
    expect(NET_ABSOLUTE_MAX_MINUTES, 'D10：绝对上限常量应为 180 分钟').toBe(180);
    expect(result.netMinutes, 'D10：500 分钟超过绝对上限，必须截断为 180').toBe(180);
    expect(result.anomaly, 'D10：截断必须标 anomaly').toBe(true);
  });

  it('D10 边界：计划为 0 时 179 不截断、181 截断', () => {
    const under = sessionNet(session({ activeMinutes: 179, plannedMinutes: 0 }));
    expect(under.netMinutes, '179 < 180，原样保留').toBe(179);
    expect(under.anomaly, '未超绝对上限不标异常').toBe(false);

    const over = sessionNet(session({ activeMinutes: 181, plannedMinutes: 0 }));
    expect(over.netMinutes, '181 > 180，截断为 180').toBe(180);
    expect(over.anomaly, '超绝对上限必须标异常').toBe(true);
  });

  it('clampCountRatio 夹在 0..1.5，计划为 0 返回 0', () => {
    expect(clampCountRatio(50, 45), '50/45 保留三位小数').toBe(1.111);
    expect(clampCountRatio(200, 45), '超限封顶 1.5').toBe(1.5);
    expect(clampCountRatio(10, 0), '计划为 0 防除零').toBe(0);
    expect(clampCountRatio(-10, 45), '负值夹到 0').toBe(0);
  });
});

describe('deriveActiveMinutes —— 休息 / idle 不计入净时长', () => {
  const segmentsWithGap = [
    { startedAt: '2025-03-01T01:00:00.000Z', endedAt: '2025-03-01T01:30:00.000Z' },
    { startedAt: '2025-03-01T02:10:00.000Z', endedAt: '2025-03-01T02:30:00.000Z' },
  ];

  it('中间 40 分钟休息 → active 只算两段共 50 分钟，休息 40 分钟进 idle', () => {
    const result = deriveActiveMinutes(segmentsWithGap, 90);
    expect(result.activeMinutes, '净时长 = 30 + 20 = 50，绝不把休息算成学习').toBe(50);
    expect(result.idleMinutes, '间隔 40 分钟 > 30 分钟阈值，计入 idle').toBe(40);
    expect(result.anomaly, '有 idle 必须标异常').toBe(true);
    expect(result.terminatedReason, '有 idle 且未达计划 → TIMEOUT').toBe('TIMEOUT');
  });

  it('多段计时乱序传入也能正确算 idle', () => {
    const result = deriveActiveMinutes([...segmentsWithGap].reverse(), 90);
    expect(result.activeMinutes, '先排序再计算，结果与有序一致').toBe(50);
    expect(result.idleMinutes, '乱序不应导致 idle 丢失').toBe(40);
  });

  it('相邻两段无间隔 → idle 为 0，状态为 PAUSED', () => {
    const result = deriveActiveMinutes(
      [
        { startedAt: '2025-03-01T01:00:00.000Z', endedAt: '2025-03-01T01:30:00.000Z' },
        { startedAt: '2025-03-01T01:30:00.000Z', endedAt: '2025-03-01T01:50:00.000Z' },
      ],
      90,
    );
    expect(result.activeMinutes, '连续计时 50 分钟').toBe(50);
    expect(result.idleMinutes, '无间隔 → idle 0').toBe(0);
    expect(result.anomaly, '无异常').toBe(false);
    expect(result.terminatedReason, '未达计划且无 idle → PAUSED').toBe('PAUSED');
  });

  it('达到计划分钟 → COMPLETED', () => {
    const result = deriveActiveMinutes(
      [{ startedAt: '2025-03-01T01:00:00.000Z', endedAt: '2025-03-01T01:50:00.000Z' }],
      50,
    );
    expect(result.activeMinutes, '50 分钟原样').toBe(50);
    expect(result.terminatedReason, '净时长达到计划 → COMPLETED').toBe('COMPLETED');
  });

  it('单段 3 分钟误触 → 净时长 0', () => {
    const result = deriveActiveMinutes(
      [{ startedAt: '2025-03-01T01:00:00.000Z', endedAt: '2025-03-01T01:03:00.000Z' }],
      45,
    );
    expect(result.activeMinutes, '3 分钟低于 max(3, 9) 的阈值边界（3 < 9）记为 0').toBe(0);
    expect(result.anomaly, '误触标异常').toBe(true);
  });
});

describe('skillMinutes —— 分桶', () => {
  it('泛听泛读只进 EXTENSIVE', () => {
    const buckets = skillMinutes([
      { skill: 'LISTENING', minutes: 45 },
      { skill: 'LISTENING_EXT', minutes: 20 },
      { skill: 'READING_EXT', minutes: 15 },
    ]);
    expect(buckets.LISTENING, '精听 45 分钟').toBe(45);
    expect(buckets.EXTENSIVE, '泛听 20 + 泛读 15').toBe(35);
    expect(buckets.READING, '泛读不得并入精读').toBe(0);
  });

  it('负分钟按 0 计（不会倒扣）', () => {
    const buckets = skillMinutes([
      { skill: 'VOCAB', minutes: 25 },
      { skill: 'VOCAB', minutes: -10 },
    ]);
    expect(buckets.VOCAB, '负值被 max(0) 夹住').toBe(25);
  });

  it('META（复盘与计划）不应被算进「句子成分」桶', () => {
    const buckets = skillMinutes([{ skill: 'META', minutes: 10 }]);
    expect(
      buckets.SENTENCE,
      'D7（已修复）：META 有独立分桶，每天 10 分钟复盘不得被算成句子成分练习',
    ).toBe(0);
  });
});

describe('其他口径', () => {
  it('sumMinutes 忽略非法数值', () => {
    expect(sumMinutes([10, Number.NaN, 20, Number.POSITIVE_INFINITY]), 'NaN/Infinity 不计').toBe(30);
    expect(sumMinutes([]), '空数组为 0').toBe(0);
  });

  it('复习负载过重：超过可用时长 25% 才提示（含边界）', () => {
    expect(isReviewLoadHeavy(60, 240), '60/240 恰好 25%，不提示').toBe(false);
    expect(isReviewLoadHeavy(61, 240), '61/240 > 25%，提示').toBe(true);
    expect(isReviewLoadHeavy(10, 0), '可用时长为 0 时不提示（避免除零）').toBe(false);
  });
});
