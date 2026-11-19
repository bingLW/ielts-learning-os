/**
 * 复习调度 —— 纯函数，零 IO。`today` 由调用方传入，函数内绝不 `new Date()`。
 *
 * 硬规则（PRD §6.3）：
 * 1. D0 = 首测日（learned_date），不是今天，也不是创建时间；
 * 2. GREEN 不生成结构化复习点；YELLOW → D1/D3/D7；RED → D1/D3/D7/D14；
 * 3. 复测后只**追加**，不覆盖原计划；
 * 4. 逾期点绝不改期（D3 没做不让 D7 后移），也**不占**未来名额；
 * 5. 同一知识点最多同时存在 4 个未完成的**未来**复习点（逾期的陈旧点不计入）；
 * 6. 连续 2 次 GREEN 且间隔 ≥7 天 → 掌握，转 30 天低频池；
 * 7. D30（及低频池）复测仍失败 → 追加一个 `LOW_FREQ_30`（+30 天），每 30 天稳定续期。
 */

import {
  COLOR_INTERVALS,
  EST_MINUTES_BY_INTERVAL,
  FULL_VOLUME_MIN_QUESTIONS,
  LOW_FREQ_INTERVAL_DAYS,
  LOW_VOLUME_RETEST_OFFSET,
  MASTERY_GREEN_STREAK,
  MASTERY_MIN_GAP_DAYS,
  MAX_PENDING_POINTS,
  REVIEW_INTERVAL_DAYS,
} from '../constants';
import { addDays, diffDays } from '../date';
import type {
  EgiuColor,
  ExistingPoint,
  IntervalCode,
  PlannedPoint,
  ReviewStatus,
} from '../types';

/** 主线间隔阶梯（复测追加沿着它往后走）。 */
const LADDER: IntervalCode[] = ['D1', 'D3', 'D7', 'D14', 'D21', 'D30'];

/** 取 `d0 + n` 与 `today` 的较大者：新点绝不落在过去。 */
function dueDateFrom(d0: string, interval: IntervalCode, today: string): string {
  const natural = addDays(d0, REVIEW_INTERVAL_DAYS[interval]);
  return diffDays(today, natural) < 0 ? today : natural;
}

function estMinutes(interval: IntervalCode, overrides?: Partial<Record<IntervalCode, number>>): number {
  const overridden = overrides?.[interval];
  if (typeof overridden === 'number' && Number.isFinite(overridden) && overridden > 0) {
    return Math.round(overridden);
  }
  return EST_MINUTES_BY_INTERVAL[interval];
}

/** 已存在同档位且未完成的点 → 不重复生成。 */
function isPendingDuplicate(existing: ExistingPoint[], interval: IntervalCode): boolean {
  return existing.some((point) => point.intervalCode === interval && point.status === 'PENDING');
}

/** 按 dueDate 升序（同日按阶梯顺序）。 */
function sortPlanned(points: PlannedPoint[]): PlannedPoint[] {
  return [...points].sort((a, b) => {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    return LADDER.indexOf(a.intervalCode) - LADDER.indexOf(b.intervalCode);
  });
}

/**
 * 首测判定后生成复习点。
 *
 * @param input.d0 首测日 `YYYY-MM-DD`
 * @param input.today 调用方给的业务今天
 * @param input.color 本次判定颜色
 * @param input.totalQuestions 本次题量；`<5` 且判 YELLOW 时追加 MANUAL 补测（+2 天）
 * @param input.existing 库中已存在的点（用于去重与 4 点上限）
 * @returns 需要**新增**的复习点（已去重、已按上限裁剪）
 */
export function generateReviewPoints(input: {
  d0: string;
  today: string;
  color: EgiuColor;
  totalQuestions: number;
  existing: ExistingPoint[];
  estMinutesByInterval?: Partial<Record<IntervalCode, number>>;
}): PlannedPoint[] {
  const { d0, today, color, totalQuestions, existing } = input;
  const intervals = COLOR_INTERVALS[color];
  if (intervals.length === 0) return [];

  const candidates: PlannedPoint[] = [];
  for (const interval of intervals) {
    if (isPendingDuplicate(existing, interval)) continue;
    candidates.push({
      intervalCode: interval,
      dueDate: dueDateFrom(d0, interval, today),
      estMinutes: estMinutes(interval, input.estMinutesByInterval),
    });
  }

  // 题量不足的补测点（MANUAL，+2 天，从 today 起算而不是 d0）
  if (color === 'YELLOW' && totalQuestions < FULL_VOLUME_MIN_QUESTIONS) {
    if (!isPendingDuplicate(existing, 'MANUAL')) {
      candidates.push({
        intervalCode: 'MANUAL',
        dueDate: addDays(today, LOW_VOLUME_RETEST_OFFSET),
        estMinutes: estMinutes('MANUAL', input.estMinutesByInterval),
      });
    }
  }

  return capPendingPoints(candidates, existing, today);
}

/**
 * 复测后追加。只追加、不改期、不覆盖。
 *
 * 规则：
 * - GREEN → 不追加（掌握判定由 `shouldMarkMastered` 负责）；
 * - YELLOW → 沿阶梯往后追加最近 2 个（D3 复测仍黄灯 → D7、D14）；
 * - RED → 沿阶梯往后追加（D7 复测仍红 → D14、D21、D30）；
 * - D30 / 低频池之后仍失败 → 追加一个 `LOW_FREQ_30`（+30 天），每 30 天稳定续期。
 */
export function appendAfterRetest(input: {
  d0: string;
  today: string;
  retestInterval: IntervalCode;
  result: EgiuColor;
  existing: ExistingPoint[];
  estMinutesByInterval?: Partial<Record<IntervalCode, number>>;
}): PlannedPoint[] {
  const { d0, today, retestInterval, result, existing } = input;
  if (result === 'GREEN' || result === 'PENDING') return [];

  // 阶梯尽头（D30 及已进低频池）之后不能断链：失败就按 30 天稳定续期**一个**低频点，
  // 每 30 天一个、不会一次产生多个（否则长期失败单元会被永久放弃，缺陷 D2）。
  if (retestInterval === 'D30' || retestInterval === 'LOW_FREQ_30') {
    if (isPendingDuplicate(existing, 'LOW_FREQ_30')) return [];
    return capPendingPoints(
      [
        {
          intervalCode: 'LOW_FREQ_30',
          dueDate: addDays(today, LOW_FREQ_INTERVAL_DAYS),
          estMinutes: estMinutes('LOW_FREQ_30', input.estMinutesByInterval),
        },
      ],
      existing,
      today,
    );
  }

  const nextIndex = nextLadderIndex(retestInterval);
  const tail = LADDER.slice(nextIndex);
  const wanted = result === 'RED' ? tail : tail.slice(0, 2);
  if (wanted.length === 0) return [];

  const candidates: PlannedPoint[] = [];
  for (const interval of wanted) {
    if (isPendingDuplicate(existing, interval)) continue;
    candidates.push({
      intervalCode: interval,
      dueDate: dueDateFrom(d0, interval, today),
      estMinutes: estMinutes(interval, input.estMinutesByInterval),
    });
  }

  return capPendingPoints(candidates, existing, today);
}

/** 当前档位在阶梯中的位置；MANUAL / LOW_FREQ_30 视为紧邻 D1 之后。 */
function nextLadderIndex(current: IntervalCode): number {
  const found = LADDER.indexOf(current);
  if (found >= 0) return found + 1;
  return 1; // D3 起
}

/**
 * 把候选点裁到「**未完成的未来点** ≤ 4」。
 *
 * 逾期点不删除、也不改期（PRD §6.3 硬规则 4），但**不占未来名额**：
 * 否则 4 个早已逾期、本该被 SKIP 的旧点会把名额永久占满，单元的复习链彻底断掉（缺陷 D3）。
 *
 * @param today 调用方给的业务今天，用来判定哪些 PENDING 点属于「未来点」
 */
function capPendingPoints(
  candidates: PlannedPoint[],
  existing: ExistingPoint[],
  today: string,
): PlannedPoint[] {
  if (candidates.length === 0) return [];
  const pendingCount = existing.filter(
    (point) => point.status === 'PENDING' && point.dueDate >= today,
  ).length;
  const slots = Math.max(0, MAX_PENDING_POINTS - pendingCount);
  if (slots === 0) return [];
  return sortPlanned(candidates).slice(0, slots);
}

/**
 * 掌握判定：连续 2 次 GREEN 且这两次间隔 ≥7 天。
 *
 * @param reviews 该单元的全部复测，按 `reviewDate` 升序传入（或由函数内部排序）
 */
export function shouldMarkMastered(input: {
  reviews: { reviewDate: string; color: EgiuColor }[];
}): { mastered: boolean; greenStreak: number; anchorGapDays?: number } {
  const sorted = [...input.reviews].sort((a, b) =>
    a.reviewDate < b.reviewDate ? -1 : a.reviewDate > b.reviewDate ? 1 : 0,
  );

  let streak = 0;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].color === 'GREEN') streak += 1;
    else break;
  }

  if (streak < MASTERY_GREEN_STREAK) {
    return { mastered: false, greenStreak: streak };
  }

  const anchor = sorted[sorted.length - 1];
  const previousGreen = sorted[sorted.length - 2];
  const gap = diffDays(previousGreen.reviewDate, anchor.reviewDate);
  if (gap >= MASTERY_MIN_GAP_DAYS) {
    return { mastered: true, greenStreak: streak, anchorGapDays: gap };
  }
  return { mastered: false, greenStreak: streak, anchorGapDays: gap };
}

/** 掌握后的低频抽测日：最后一次复测 + 30 天。 */
export function nextLowFreqDate(lastDate: string): string {
  return addDays(lastDate, LOW_FREQ_INTERVAL_DAYS);
}

/** 三色分布：入参必须是「每个单元只取其最新一次判定」的集合。 */
export function colorDistribution(latest: { color: EgiuColor }[]): Record<EgiuColor, number> {
  const out: Record<EgiuColor, number> = { PENDING: 0, GREEN: 0, YELLOW: 0, RED: 0 };
  for (const item of latest) {
    out[item.color] += 1;
  }
  return out;
}

/** 逾期天数（`today - dueDate`，负数表示还没到期）。 */
export function overdueDays(dueDate: string, today: string): number {
  return diffDays(dueDate, today);
}

/** 未完成（PENDING）判定，供查询层过滤。 */
export function isPending(status: ReviewStatus): boolean {
  return status === 'PENDING';
}
