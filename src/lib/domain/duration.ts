/**
 * 净时长聚合 —— 纯函数。
 *
 * 口径（PRD §6.6 / §6.3 边界 6）：
 * - 单 session 实际时长 = `min(计时时长, 计划时长 × 1.5)`（防挂机）；
 * - 计划时长为 0 时退化为**绝对上限** `NET_ABSOLUTE_MAX_MINUTES`（180 分钟）；
 * - 实际 < `max(3min, 计划 × 0.2)` 视为误触，记 0；
 * - 中断（相邻计时段间隔 >30min）区间计入 idle，不计 active;
 * - 休息不计入;
 * - 跨零点按分钟占比拆分到两个自然日，`Σminutes === activeMinutes`。
 */

import {
  IDLE_GAP_MINUTES,
  NET_ABSOLUTE_MAX_MINUTES,
  NET_MAX_RATIO,
  NET_MIN_MINUTES,
  NET_MIN_RATIO,
  REVIEW_LOAD_WARN_RATIO,
  SKILL_BUCKET,
} from '../constants';
import { splitAcrossMidnight } from '../date';
import type { SessionLike, SessionNetResult, SkillBucket, SkillId } from '../types';

export { IDLE_GAP_MINUTES };
export { splitAcrossMidnight };

const MS_PER_MINUTE = 60_000;

/** 一段原始计时（ISO 时刻）。 */
export interface RawSegment {
  startedAt: string;
  endedAt: string;
}

/**
 * 从多段计时推出 active / idle。
 *
 * @param segments 同一任务的多段计时（可乱序）
 * @param plannedMinutes 该任务的计划分钟，用于判断是否超限
 */
export function deriveActiveMinutes(
  segments: RawSegment[],
  plannedMinutes: number,
): {
  activeMinutes: number;
  idleMinutes: number;
  anomaly: boolean;
  terminatedReason: 'COMPLETED' | 'PAUSED' | 'TIMEOUT';
} {
  const parsed = segments
    .map((segment) => ({
      start: new Date(segment.startedAt).getTime(),
      end: new Date(segment.endedAt).getTime(),
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .sort((a, b) => a.start - b.start);

  let activeMs = 0;
  let idleMinutes = 0;

  parsed.forEach((segment, index) => {
    activeMs += Math.max(0, segment.end - segment.start);
    const previous = index > 0 ? parsed[index - 1] : null;
    if (previous) {
      const gapMs = segment.start - previous.end;
      if (gapMs > IDLE_GAP_MINUTES * MS_PER_MINUTE) {
        idleMinutes += Math.round(gapMs / MS_PER_MINUTE);
      }
    }
  });

  const rawActive = Math.round(activeMs / MS_PER_MINUTE);
  const { netMinutes, anomaly: netAnomaly } = sessionNet({
    activeMinutes: rawActive,
    plannedMinutes,
    startedAt: segments[0]?.startedAt ?? new Date(0).toISOString(),
    endedAt: segments[segments.length - 1]?.endedAt ?? new Date(0).toISOString(),
    idleMinutes,
  });

  const anomaly = netAnomaly || idleMinutes > 0;
  const terminatedReason: 'COMPLETED' | 'PAUSED' | 'TIMEOUT' =
    plannedMinutes > 0 && netMinutes >= plannedMinutes
      ? 'COMPLETED'
      : idleMinutes > 0
        ? 'TIMEOUT'
        : 'PAUSED';

  return { activeMinutes: netMinutes, idleMinutes, anomaly, terminatedReason };
}

/** `clamp(active/planned, 0, 1.5)`；`planned <= 0` 时返回 0，避免除零。 */
export function clampCountRatio(activeMinutes: number, plannedMinutes: number): number {
  if (plannedMinutes <= 0) return 0;
  const ratio = activeMinutes / plannedMinutes;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(NET_MAX_RATIO, Math.max(0, Math.round(ratio * 1000) / 1000));
}

/**
 * 单计时段净时长。
 *
 * 顺序很重要：先判「误触」（用原始计时），再判「挂机截断」，
 * 否则 3 分钟误触会被截断逻辑误判成有效时长。
 */
export function sessionNet(session: SessionLike): SessionNetResult {
  const planned = Math.max(0, session.plannedMinutes);
  const rawActive = Math.max(0, session.activeMinutes);
  const minRequired = Math.max(NET_MIN_MINUTES, planned * NET_MIN_RATIO);

  if (rawActive < minRequired) {
    return {
      netMinutes: 0,
      anomaly: true,
      reason: `实际 ${rawActive} 分钟低于有效阈值 ${Math.round(minRequired)} 分钟，记为误触`,
    };
  }

  // 计划时长为 0（数据缺失 / 手工建的任务）时 1.5 倍上限无从计算，
  // 必须用绝对上限兜底，否则「500 分钟」也会原样入库（缺陷 D10）。
  if (planned <= 0) {
    if (rawActive > NET_ABSOLUTE_MAX_MINUTES) {
      return {
        netMinutes: NET_ABSOLUTE_MAX_MINUTES,
        anomaly: true,
        reason: `计划时长为 0，实际 ${rawActive} 分钟超过 ${NET_ABSOLUTE_MAX_MINUTES} 分钟绝对上限，已截断`,
      };
    }
    return { netMinutes: rawActive, anomaly: false };
  }

  if (rawActive > planned * NET_MAX_RATIO) {
    return {
      netMinutes: Math.round(planned * NET_MAX_RATIO),
      anomaly: true,
      reason: `实际 ${rawActive} 分钟超过计划 ${planned} 分钟的 1.5 倍，已截断`,
    };
  }

  return { netMinutes: rawActive, anomaly: false };
}

/**
 * 按 skill 汇总分钟数到各桶（9 个桶，含独立的 `META`）。
 *
 * 泛听/泛读只进 `EXTENSIVE`；复盘与计划（`META`）只进 `META`，
 * **绝不并入 `SENTENCE`** —— 否则每天 10 分钟复盘会被当成句子成分练习（缺陷 D7）。
 */
export function skillMinutes(rows: { skill: SkillId; minutes: number }[]): Record<SkillBucket, number> {
  const out: Record<SkillBucket, number> = {
    LISTENING: 0,
    READING: 0,
    SPEAKING: 0,
    WRITING: 0,
    EXTENSIVE: 0,
    VOCAB: 0,
    GRAMMAR: 0,
    SENTENCE: 0,
    META: 0,
    MEDIATED: 0,
  };
  for (const row of rows) {
    const bucket = SKILL_BUCKET[row.skill];
    if (!bucket) continue;
    out[bucket] += Math.max(0, Math.round(row.minutes));
  }
  return out;
}

/** 把跨零点拆分结果聚成「日期 → 分钟」。日净时长**只**从这张表求和。 */
export function netMinutesByDate(
  splits: { date: string; minutes: number }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const split of splits) {
    out[split.date] = (out[split.date] ?? 0) + split.minutes;
  }
  return out;
}

/** 分钟求和。 */
export function sumMinutes(values: number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

/** 复习负载是否过重：预估复习分钟 > 可用时长 × 25%（§6.3 边界 4）。 */
export function isReviewLoadHeavy(estMinutes: number, dailyMinutes: number): boolean {
  if (dailyMinutes <= 0) return false;
  return estMinutes / dailyMinutes > REVIEW_LOAD_WARN_RATIO;
}
