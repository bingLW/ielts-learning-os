import { describe, expect, it } from 'vitest';

import {
  calibrateTaskEstimate,
  defaultTaskEstimate,
  parseTaskEstimate,
} from '@/lib/domain/taskEstimate';

describe('P1-1 任务估时区间与历史校准', () => {
  it('默认保留点估计，并显式记录区间/模型/规则版本', () => {
    expect(defaultTaskEstimate(20)).toEqual({
      pointMinutes: 20,
      minMinutes: 16,
      maxMinutes: 26,
      basis: 'ESTIMATE',
      modelVersion: 'estimate-range-v2.7.1',
      ruleVersion: 'v2.7.1',
      sampleCount: 0,
      calibrationKey: null,
    });
    expect(defaultTaskEstimate(0.5)).toMatchObject({
      pointMinutes: 0.5,
      minMinutes: 0.5,
      maxMinutes: 1.5,
    });
  });

  it('不足三个有效样本仍是 ESTIMATE，不伪装成校准', () => {
    const estimate = calibrateTaskEstimate(20, [{ minutes: 10 }, { minutes: 30 }, { minutes: 0 }], 'skill:READING');
    expect(estimate.basis).toBe('ESTIMATE');
    expect(estimate.pointMinutes).toBe(20);
    expect(estimate.sampleCount).toBe(0);
    expect(estimate.calibrationKey).toBeNull();
  });

  it('三个有效样本以中位数校准点估计，以 P25–P75 给出区间', () => {
    expect(calibrateTaskEstimate(20, [
      { minutes: 40 }, { minutes: 10 }, { minutes: 20 },
    ], 'skill:READING')).toEqual({
      pointMinutes: 20,
      minMinutes: 15,
      maxMinutes: 30,
      basis: 'CALIBRATED',
      modelVersion: 'estimate-range-v2.7.1',
      ruleVersion: 'v2.7.1',
      sampleCount: 3,
      calibrationKey: 'skill:READING',
    });
  });

  it('损坏或样本不足的校准快照不会被读侧接受', () => {
    const valid = calibrateTaskEstimate(20, [{ minutes: 10 }, { minutes: 20 }, { minutes: 30 }], 'skill:READING');
    expect(parseTaskEstimate(valid)).toEqual(valid);
    expect(parseTaskEstimate({ ...valid, sampleCount: 2 })).toBeNull();
    expect(parseTaskEstimate({ ...valid, calibrationKey: null })).toBeNull();
    expect(parseTaskEstimate({ ...valid, maxMinutes: valid.minMinutes })).toBeNull();
    expect(parseTaskEstimate({ ...valid, pointMinutes: valid.minMinutes - 1 })).toBeNull();
    expect(parseTaskEstimate({ ...valid, pointMinutes: valid.maxMinutes + 1 })).toBeNull();
    expect(parseTaskEstimate({ ...valid, ruleVersion: '' })).toBeNull();
    expect(parseTaskEstimate(null)).toBeNull();
  });
});
