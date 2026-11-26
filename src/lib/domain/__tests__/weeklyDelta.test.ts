/**
 * T13 `buildWeeklyDelta()` —— AC-12 三条验收。
 *
 * ① 两周快照 → 改善 / 未解决 / 需诊断三类，每类带指标依据；
 * ② 有效学习 < 2 天 → 「暂不下结论」且不生成建议；
 * ③ 单周波动未达阈值（连续 2 周 ≥15% 或样本 ≥N）→ `changeRecommended=false` + 阈值说明。
 */

import { describe, expect, test } from 'vitest';
import { WEEKLY_DELTA_SAMPLE_N, WEEKLY_DELTA_TREND_THRESHOLD } from '../../constants';
import { buildWeeklyDelta, type WeeklyDeltaSnapshot } from '../weeklyDelta';

function snapshot(overrides: Partial<WeeklyDeltaSnapshot> = {}): WeeklyDeltaSnapshot {
  return {
    weekStart: '2026-11-16',
    activeDays: 5,
    accuracy: 0.6,
    accuracySample: 20,
    retestKeepRate: 0.7,
    retestSample: 20,
    evidenceCount: 40,
    uncertaintyCount: 1,
    ...overrides,
  };
}

describe('buildWeeklyDelta —— AC-12 ① 三类结论带依据', () => {
  test('改善 / 未解决 / 需诊断 同时出现，每条都写出上周→本周数字', () => {
    const previous = snapshot({
      weekStart: '2026-11-09',
      accuracy: 0.6,
      accuracySample: 20,
      retestKeepRate: 0.7,
      retestSample: 20,
      uncertaintyCount: 1,
    });
    const current = snapshot({
      weekStart: '2026-11-16',
      accuracy: 0.78,
      accuracySample: 25,
      retestKeepRate: 0.7,
      retestSample: 20,
      uncertaintyCount: 2,
    });

    const delta = buildWeeklyDelta({ current, previous });

    expect(delta.sampleInsufficient).toBe(false);
    const improvedLabels = delta.improved.map((item) => item.label);
    const unresolvedLabels = delta.unresolved.map((item) => item.label);
    const diagnosisLabels = delta.needsDiagnosis.map((item) => item.label);

    expect(improvedLabels).toContain('正确率');
    expect(unresolvedLabels).toContain('延迟复测保持率');
    expect(diagnosisLabels).toContain('待确认维度');

    for (const item of [...delta.improved, ...delta.unresolved, ...delta.needsDiagnosis]) {
      expect(item.detail.length).toBeGreaterThan(0);
      expect(item.detail).toMatch(/→/);
    }
    expect(delta.headline).toContain('改善');
  });

  test('判定样本低于 N → 正确率进「需诊断」，不冒充改善', () => {
    const previous = snapshot({ accuracy: 0.6, accuracySample: 4 });
    const current = snapshot({ accuracy: 0.9, accuracySample: 5 });

    const delta = buildWeeklyDelta({ current, previous });

    expect(delta.improved.map((item) => item.label)).not.toContain('正确率');
    const accuracy = delta.needsDiagnosis.find((item) => item.label === '正确率');
    expect(accuracy).toBeDefined();
    expect(accuracy?.detail).toContain('样本低于');
  });
});

describe('buildWeeklyDelta —— AC-12 ② 样本不足不生成建议', () => {
  test('有效学习 1 天 → 暂不下结论，suggestions 为空', () => {
    const delta = buildWeeklyDelta({
      current: snapshot({ activeDays: 1, accuracy: 0.9 }),
      previous: snapshot({ accuracy: 0.4 }),
    });

    expect(delta.sampleInsufficient).toBe(true);
    expect(delta.changeRecommended).toBe(false);
    expect(delta.suggestions).toEqual([]);
    expect(delta.improved).toEqual([]);
    expect(delta.unresolved).toEqual([]);
    expect(delta.headline).toContain('暂不下结论');
    expect(delta.thresholdNote).toContain('样本门槛');
  });

  test('有效学习正好 2 天 → 不触发样本不足分支', () => {
    const delta = buildWeeklyDelta({
      current: snapshot({ activeDays: 2 }),
      previous: snapshot(),
    });
    expect(delta.sampleInsufficient).toBe(false);
  });
});

describe('buildWeeklyDelta —— AC-12 ③ 单周波动未达阈值', () => {
  test('单周 +9% 且无上上周 → changeRecommended=false 且说明阈值', () => {
    const previous = snapshot({ accuracy: 0.6, accuracySample: 12 });
    const current = snapshot({ accuracy: 0.655, accuracySample: 12 });

    const delta = buildWeeklyDelta({ current, previous });

    expect(delta.changeRecommended).toBe(false);
    expect(delta.suggestions).toEqual([]);
    expect(delta.thresholdNote).toContain('未达改计划阈值');
    expect(delta.thresholdNote).toContain(`${Math.round(WEEKLY_DELTA_TREND_THRESHOLD * 100)}%`);
    expect(delta.thresholdNote).toContain(String(WEEKLY_DELTA_SAMPLE_N));
  });

  test('连续 2 周同向 ≥15% → 建议改计划', () => {
    const prior = snapshot({ weekStart: '2026-11-02', accuracy: 0.55, accuracySample: 5 });
    const previous = snapshot({ weekStart: '2026-11-09', accuracy: 0.65, accuracySample: 5 });
    const current = snapshot({ weekStart: '2026-11-16', accuracy: 0.8, accuracySample: 5 });

    const delta = buildWeeklyDelta({ current, previous, prior });

    expect(delta.changeRecommended).toBe(true);
    expect(delta.thresholdNote).toContain('连续 2 周');
    expect(delta.suggestions.length).toBeGreaterThan(0);
  });

  test('单周 ≥15% 且本周样本 ≥N → 无需连续两周也可建议', () => {
    const previous = snapshot({ accuracy: 0.6, accuracySample: 20 });
    const current = snapshot({ accuracy: 0.8, accuracySample: 20 });

    const delta = buildWeeklyDelta({ current, previous });
    expect(delta.changeRecommended).toBe(true);
    expect(delta.suggestions.length).toBeGreaterThan(0);
  });
});

describe('buildWeeklyDelta —— 无上周基线', () => {
  test('previous=null → 只记录，三类结论为空 + 一条基线提示', () => {
    const delta = buildWeeklyDelta({ current: snapshot(), previous: null });
    expect(delta.sampleInsufficient).toBe(false);
    expect(delta.improved).toEqual([]);
    expect(delta.unresolved).toEqual([]);
    expect(delta.needsDiagnosis).toHaveLength(1);
    expect(delta.needsDiagnosis[0].label).toContain('基线');
    expect(delta.changeRecommended).toBe(false);
  });
});