/**
 * 聚合口径：加权正确率、完成率、净时长、跨零点拆分。
 */

import { describe, expect, it } from 'vitest';
import { completionRate, taskWeight } from '../completion';
import { weightedAccuracy } from '../accuracy';
import { clampCountRatio, sessionNet, skillMinutes, splitAcrossMidnight } from '../duration';
import { addDays, diffDays, isoWeek, weekRange } from '../../date';

describe('weightedAccuracy', () => {
  it('Σcorrect / Σtotal（total=0 剔除）', () => {
    expect(
      weightedAccuracy([
        { total: 9, correct: 9 },
        { total: 0, correct: 0 },
        { total: 3, correct: 1 },
      ]),
    ).toBeCloseTo(10 / 12, 5);
  });

  it('correct > total 时夹到 total（脏数据不制造 >100% 正确率）', () => {
    expect(weightedAccuracy([{ total: 1, correct: 2 }])).toBe(1);
    expect(weightedAccuracy([{ total: 10, correct: 12 }])).toBe(1);
  });

  it('负数 correct 夹到 0', () => {
    expect(weightedAccuracy([{ total: 10, correct: -3 }])).toBe(0);
  });

  it('全部样本被剔除 → null（不是 0）', () => {
    expect(weightedAccuracy([{ total: 0, correct: 0 }, { total: null, correct: null }])).toBeNull();
  });

  it('空数组 → null', () => {
    expect(weightedAccuracy([])).toBeNull();
  });
});

describe('completionRate', () => {
  it('按时长加权（DONE=1，PARTIAL 按比例）', () => {
    const result = completionRate([
      { plannedMinutes: 45, actualMinutes: 45, status: 'DONE' },
      { plannedMinutes: 40, actualMinutes: 20, status: 'PARTIAL' },
      { plannedMinutes: 15, actualMinutes: 0, status: 'MISSED' },
    ]);
    expect(result.byTime).toBeCloseTo((45 + 20 + 0) / 100, 5);
    expect(result.byCount).toBeCloseTo(1 / 3, 5);
  });

  it('分母为 0 → null', () => {
    expect(completionRate([])).toEqual({ byTime: null, byCount: null });
  });

  it('权重上限为 1（实际超过计划不放大）', () => {
    expect(taskWeight({ plannedMinutes: 10, actualMinutes: 999, status: 'PARTIAL' })).toBe(1);
  });
});

describe('sessionNet', () => {
  it('超过计划 1.5 倍 → 截断并标异常', () => {
    const result = sessionNet({
      activeMinutes: 200,
      plannedMinutes: 45,
      startedAt: '2025-03-01T00:00:00.000Z',
      endedAt: '2025-03-01T03:20:00.000Z',
      idleMinutes: 0,
    });
    expect(result.netMinutes).toBe(68);
    expect(result.anomaly).toBe(true);
  });

  it('低于 max(3, 计划×0.2) → 记 0 并标异常', () => {
    const result = sessionNet({
      activeMinutes: 2,
      plannedMinutes: 45,
      startedAt: '2025-03-01T00:00:00.000Z',
      endedAt: '2025-03-01T00:02:00.000Z',
      idleMinutes: 0,
    });
    expect(result.netMinutes).toBe(0);
    expect(result.anomaly).toBe(true);
  });

  it('正常区间原样返回', () => {
    const result = sessionNet({
      activeMinutes: 40,
      plannedMinutes: 45,
      startedAt: '2025-03-01T00:00:00.000Z',
      endedAt: '2025-03-01T00:40:00.000Z',
      idleMinutes: 0,
    });
    expect(result.netMinutes).toBe(40);
    expect(result.anomaly).toBe(false);
  });

  it('countRatio 夹在 0..1.5', () => {
    expect(clampCountRatio(200, 45)).toBe(1.5);
    expect(clampCountRatio(10, 0)).toBe(0);
  });
});

describe('splitAcrossMidnight', () => {
  it('跨零点按分钟占比拆分，Σ === active', () => {
    // 2025-03-01 23:50 (+08:00) = 2025-03-01T15:50:00Z
    const splits = splitAcrossMidnight('2025-03-01T15:50:00.000Z', 20);
    expect(splits.reduce((sum, split) => sum + split.minutes, 0)).toBe(20);
    expect(splits.map((split) => split.date)).toEqual(['2025-03-01', '2025-03-02']);
    expect(splits[0].minutes).toBe(10);
    expect(splits[1].minutes).toBe(10);
  });

  it('不跨零点时只有一个日期', () => {
    const splits = splitAcrossMidnight('2025-03-01T02:00:00.000Z', 45);
    expect(splits).toEqual([{ date: '2025-03-01', minutes: 45 }]);
  });
});

describe('skillMinutes', () => {
  it('泛听泛读只进 EXTENSIVE，不并入听力/阅读', () => {
    const buckets = skillMinutes([
      { skill: 'LISTENING', minutes: 45 },
      { skill: 'LISTENING_EXT', minutes: 20 },
      { skill: 'READING_EXT', minutes: 15 },
    ]);
    expect(buckets.LISTENING).toBe(45);
    expect(buckets.READING).toBe(0);
    expect(buckets.EXTENSIVE).toBe(35);
  });
});

describe('日期工具', () => {
  it('addDays 跨月', () => {
    expect(addDays('2025-03-31', 1)).toBe('2025-04-01');
  });

  it('diffDays 跨年', () => {
    expect(diffDays('2024-12-31', '2025-01-01')).toBe(1);
  });

  it('isoWeek 跨年边界正确（2026-01-01 属 2026-W01）', () => {
    expect(isoWeek('2026-01-01')).toEqual({ isoYear: 2026, isoWeek: 1 });
  });

  it('weekRange 周一到周日', () => {
    expect(weekRange('2025-03-05')).toEqual({ weekStart: '2025-03-03', weekEnd: '2025-03-09' });
  });
});
