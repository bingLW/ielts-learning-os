import type { TaskEstimate } from '../types';
import { RULE_VERSION } from './planningSnapshot';

/** 估时模型版本；规则版本另存，二者共同构成历史快照的可复算标识。 */
export const ESTIMATE_MODEL_VERSION = 'estimate-range-v2.7.1';
export const ESTIMATE_MIN_SAMPLES = 3;
export const ESTIMATE_WINDOW_DAYS = 90;

export interface EstimateCalibrationSample {
  minutes: number;
}

function validSamples(samples: readonly EstimateCalibrationSample[]): number[] {
  return samples
    .map((sample) => sample.minutes)
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0)
    .sort((a, b) => a - b);
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** 默认区间只表达估计不确定性，不改变既有评分/装箱使用的点估计。 */
export function defaultTaskEstimate(pointMinutes: number): TaskEstimate {
  const point = Number.isFinite(pointMinutes) && pointMinutes > 0 ? pointMinutes : 1;
  const minMinutes = Math.min(point, Math.max(1, Math.round(point * 0.8)));
  const maxMinutes = Math.max(point + 1, Math.round(point * 1.3));
  return {
    pointMinutes: point,
    minMinutes,
    maxMinutes,
    basis: 'ESTIMATE',
    modelVersion: ESTIMATE_MODEL_VERSION,
    ruleVersion: RULE_VERSION,
    sampleCount: 0,
    calibrationKey: null,
  };
}

/** 至少 3 个有效历史样本才校准；中位数为点估计，P25–P75 为区间。 */
export function calibrateTaskEstimate(
  pointMinutes: number,
  samples: readonly EstimateCalibrationSample[],
  calibrationKey: string,
): TaskEstimate {
  const fallback = defaultTaskEstimate(pointMinutes);
  const valid = validSamples(samples);
  if (valid.length < ESTIMATE_MIN_SAMPLES) return fallback;
  const point = Math.max(1, Math.round(quantile(valid, 0.5)));
  const minMinutes = Math.max(1, Math.min(point, Math.round(quantile(valid, 0.25))));
  const maxMinutes = Math.max(point + 1, Math.round(quantile(valid, 0.75)));
  return {
    pointMinutes: point,
    minMinutes,
    maxMinutes,
    basis: 'CALIBRATED',
    modelVersion: ESTIMATE_MODEL_VERSION,
    ruleVersion: RULE_VERSION,
    sampleCount: valid.length,
    calibrationKey,
  };
}

/** 只接受完整、有限且有序的快照；损坏 JSON 不得伪装成校准结果。 */
export function parseTaskEstimate(value: unknown): TaskEstimate | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const point = row.pointMinutes;
  const min = row.minMinutes;
  const max = row.maxMinutes;
  if (
    typeof point !== 'number' || !Number.isFinite(point) || point <= 0 ||
    typeof min !== 'number' || !Number.isFinite(min) || min <= 0 ||
    typeof max !== 'number' || !Number.isFinite(max) || max <= min ||
    point < min || point > max ||
    (row.basis !== 'ESTIMATE' && row.basis !== 'CALIBRATED') ||
    typeof row.modelVersion !== 'string' || row.modelVersion.length === 0 ||
    typeof row.ruleVersion !== 'string' || row.ruleVersion.length === 0 ||
    typeof row.sampleCount !== 'number' || !Number.isInteger(row.sampleCount) || row.sampleCount < 0 ||
    (row.calibrationKey !== null && typeof row.calibrationKey !== 'string')
  ) return null;
  if (row.basis === 'CALIBRATED' && (row.sampleCount < ESTIMATE_MIN_SAMPLES || !row.calibrationKey)) return null;
  return {
    pointMinutes: point,
    minMinutes: min,
    maxMinutes: max,
    basis: row.basis,
    modelVersion: row.modelVersion,
    ruleVersion: row.ruleVersion,
    sampleCount: row.sampleCount,
    calibrationKey: row.calibrationKey,
  };
}
