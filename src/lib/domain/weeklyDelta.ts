/**
 * 周复盘变化（v2.7 AC-12）—— 纯函数，零 IO。
 *
 * 拿「本周 / 上周 / 上上周」三份指标快照，产出三类结论：
 * 改善（有证据支持）/ 未解决（本周未改善）/ 需进一步诊断（样本不足或置信度未提升）。
 *
 * 三条硬约束：
 *
 * 1. **有效学习 < 2 天 → 不下结论、不生成建议**。两天的样本无法区分「真的变好」
 *    与「这周恰好做了两套熟题」，基于噪声改计划比不改更糟（PRD §4.8 空态）。
 * 2. **单周波动不改计划**：要么同一方向连续 2 周 ≥15%，要么本周样本 ≥N（N 沿用
 *    `WEAKNESS_MIN_QUESTIONS`）。只波动一周且样本不足 → `changeRecommended=false`，
 *    并把阈值原因写进 `thresholdNote` 给用户看（PRD §4.8⑥）。
 * 3. **每类结论必须带指标依据**：`detail` 里写清「上周 X → 本周 Y」，不让用户
 *    对着一句「有改善」猜是哪个指标、凭什么。
 */

import {
  WEEKLY_DELTA_MIN_ACTIVE_DAYS,
  WEEKLY_DELTA_SAMPLE_N,
  WEEKLY_DELTA_TREND_THRESHOLD,
} from '../constants';
import { EMPTY_PLACEHOLDER, formatPercent } from '../format';

/** 一周用于比较的指标快照（由 query 层聚合，这里不读库）。 */
export interface WeeklyDeltaSnapshot {
  /** 该周周一（YYYY-MM-DD），用于 UI 标注对比的是哪一周。 */
  weekStart: string;
  /** 有效学习天数（当日净时长 > 0）。 */
  activeDays: number;
  /** 三色判定的正确率（绿 /（绿+黄+红））；本周无判定 → null。 */
  accuracy: number | null;
  /** 正确率的样本量（参与判定的题数）。 */
  accuracySample: number;
  /** 延迟复测保持率（PASS /（PASS+FAIL））；本周无复测 → null。 */
  retestKeepRate: number | null;
  /** 延迟复测的样本量（PASS+FAIL）。 */
  retestSample: number;
  /** 本周判定条数（三色 + 复测），只作依据展示，不单独成类。 */
  evidenceCount: number;
  /** 该周末最新诊断快照里的待确认维度数（UNCERTAINTY + UNKNOWN）。 */
  uncertaintyCount: number;
}

export interface WeeklyDeltaInput {
  current: WeeklyDeltaSnapshot;
  /** 上周；首次使用系统时为 null（此时只记录，不做趋势判断）。 */
  previous: WeeklyDeltaSnapshot | null;
  /** 上上周；仅用于判定「连续 2 周同向 ≥15%」，缺省则只能按单周 + 样本门槛判定。 */
  prior?: WeeklyDeltaSnapshot | null;
}

export type WeeklyDeltaCategory = 'IMPROVED' | 'UNRESOLVED' | 'NEEDS_DIAGNOSIS';

export type WeeklyDeltaMetric = 'ACCURACY' | 'RETEST_KEEP' | 'UNCERTAINTY';

export interface WeeklyDeltaItem {
  metric: WeeklyDeltaMetric;
  category: WeeklyDeltaCategory;
  /** 指标中文名（「正确率」「延迟复测保持率」「待确认维度」）。 */
  label: string;
  /** 指标依据：上周 → 本周的原始数字与人话解释。 */
  detail: string;
  /** 有证据支持的改善 / 下降 / 持平 / 无数据。 */
  direction: 'UP' | 'DOWN' | 'FLAT' | 'NA';
}

export interface WeeklyDeltaSuggestion {
  kind: 'ADJUST_TIME' | 'ADJUST_FOCUS' | 'KEEP';
  /** 建议正文，1–500 字（与 `weeklySuggestionSchema` 同约束）。 */
  note: string;
  /** 变更原因：为什么建议这么调（PRD §4.8⑤ 每条调整带原因）。 */
  basis: string;
}

export interface WeeklyDeltaResult {
  /** 有效学习 < 2 天：只记录、不下结论、不生成建议。 */
  sampleInsufficient: boolean;
  /** 一句话结论（UI 直接展示，不现场拼）。 */
  headline: string;
  improved: WeeklyDeltaItem[];
  unresolved: WeeklyDeltaItem[];
  needsDiagnosis: WeeklyDeltaItem[];
  /** 是否建议调整下周计划（预算 / 技能配比）。 */
  changeRecommended: boolean;
  /** 阈值说明文案：无论建议与否都要展示（PRD §4.8⑥ 明确要求可见）。 */
  thresholdNote: string;
  /** 样本不足时恒为空数组。 */
  suggestions: WeeklyDeltaSuggestion[];
}

interface MetricMove {
  direction: 'UP' | 'DOWN' | 'FLAT' | 'NA';
  /** 本周 − 上周（绝对值）。 */
  delta: number | null;
  /** 相对变化（delta / 上周）；上周为 0 时按方向取 ±1。 */
  relative: number | null;
  /** |relative| ≥ 阈值。 */
  significant: boolean;
}

function metricMove(current: number | null, previous: number | null): MetricMove {
  if (current === null || previous === null) {
    return { direction: 'NA', delta: null, relative: null, significant: false };
  }
  const delta = current - previous;
  const relative = previous > 0 ? delta / previous : delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const direction = delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : 'FLAT';
  return {
    direction,
    delta,
    relative,
    significant: Math.abs(relative) >= WEEKLY_DELTA_TREND_THRESHOLD,
  };
}

/** `+12%` / `−8%` / `0%`（相对变化，用于人话依据）。 */
function signedRelativeText(move: MetricMove): string {
  if (move.relative === null) return EMPTY_PLACEHOLDER;
  const percent = Math.round(move.relative * 100);
  if (percent === 0) return '0%';
  return percent > 0 ? `+${percent}%` : `${percent}%`;
}

function accuracyText(value: number | null): string {
  return value === null ? '无判定' : formatPercent(value);
}

/** 样本是否足以支撑「有证据支持」的判断（两周都不低于 N）。 */
function sampleEnough(current: number, previous: number | null): boolean {
  return current >= WEEKLY_DELTA_SAMPLE_N && previous !== null && previous >= WEEKLY_DELTA_SAMPLE_N;
}

function accuracyItem(
  current: WeeklyDeltaSnapshot,
  previous: WeeklyDeltaSnapshot,
): WeeklyDeltaItem {
  const move = metricMove(current.accuracy, previous.accuracy);
  const detail = `正确率 ${accuracyText(previous.accuracy)} → ${accuracyText(
    current.accuracy,
  )}（${signedRelativeText(move)}），判定 ${current.accuracySample} 题（上周 ${
    previous.accuracySample
  } 题）`;

  if (current.accuracy === null || previous.accuracy === null) {
    return {
      metric: 'ACCURACY',
      category: 'NEEDS_DIAGNOSIS',
      label: '正确率',
      detail: `${detail}：本周或上周没有判定样本，无法比较`,
      direction: 'NA',
    };
  }
  if (!sampleEnough(current.accuracySample, previous.accuracySample)) {
    return {
      metric: 'ACCURACY',
      category: 'NEEDS_DIAGNOSIS',
      label: '正确率',
      detail: `${detail}；样本低于 ${WEEKLY_DELTA_SAMPLE_N} 题，暂不下结论`,
      direction: move.direction,
    };
  }
  if (move.significant && move.direction === 'UP') {
    return {
      metric: 'ACCURACY',
      category: 'IMPROVED',
      label: '正确率',
      detail: `${detail}，达 ${Math.round(WEEKLY_DELTA_TREND_THRESHOLD * 100)}% 改善阈值`,
      direction: 'UP',
    };
  }
  return {
    metric: 'ACCURACY',
    category: 'UNRESOLVED',
    label: '正确率',
    detail:
      move.direction === 'DOWN'
        ? `${detail}，较上周下降`
        : `${detail}，未达 ${Math.round(WEEKLY_DELTA_TREND_THRESHOLD * 100)}% 改善阈值`,
    direction: move.direction,
  };
}

function retestItem(
  current: WeeklyDeltaSnapshot,
  previous: WeeklyDeltaSnapshot,
): WeeklyDeltaItem {
  const move = metricMove(current.retestKeepRate, previous.retestKeepRate);
  const detail = `延迟复测保持率 ${accuracyText(previous.retestKeepRate)} → ${accuracyText(
    current.retestKeepRate,
  )}（${signedRelativeText(move)}），复测 ${current.retestSample} 条（上周 ${
    previous.retestSample
  } 条）`;

  if (current.retestKeepRate === null || previous.retestKeepRate === null) {
    return {
      metric: 'RETEST_KEEP',
      category: 'NEEDS_DIAGNOSIS',
      label: '延迟复测保持率',
      detail: `${detail}：本周或上周没有复测记录，无法比较`,
      direction: 'NA',
    };
  }
  if (!sampleEnough(current.retestSample, previous.retestSample)) {
    return {
      metric: 'RETEST_KEEP',
      category: 'NEEDS_DIAGNOSIS',
      label: '延迟复测保持率',
      detail: `${detail}；样本低于 ${WEEKLY_DELTA_SAMPLE_N} 条，暂不下结论`,
      direction: move.direction,
    };
  }
  if (move.significant && move.direction === 'UP') {
    return {
      metric: 'RETEST_KEEP',
      category: 'IMPROVED',
      label: '延迟复测保持率',
      detail: `${detail}，达 ${Math.round(WEEKLY_DELTA_TREND_THRESHOLD * 100)}% 改善阈值`,
      direction: 'UP',
    };
  }
  return {
    metric: 'RETEST_KEEP',
    category: 'UNRESOLVED',
    label: '延迟复测保持率',
    detail:
      move.direction === 'DOWN'
        ? `${detail}，记忆保持变差`
        : `${detail}，未达 ${Math.round(WEEKLY_DELTA_TREND_THRESHOLD * 100)}% 改善阈值`,
    direction: move.direction,
  };
}

function uncertaintyItem(
  current: WeeklyDeltaSnapshot,
  previous: WeeklyDeltaSnapshot,
): WeeklyDeltaItem | null {
  if (current.uncertaintyCount === 0 && previous.uncertaintyCount === 0) return null;
  const detail = `待确认维度 ${previous.uncertaintyCount} → ${current.uncertaintyCount}`;
  if (current.uncertaintyCount < previous.uncertaintyCount) {
    return {
      metric: 'UNCERTAINTY',
      category: 'IMPROVED',
      label: '待确认维度',
      detail: `${detail}，置信度提升`,
      direction: 'DOWN',
    };
  }
  return {
    metric: 'UNCERTAINTY',
    category: 'NEEDS_DIAGNOSIS',
    label: '待确认维度',
    detail:
      current.uncertaintyCount > previous.uncertaintyCount
        ? `${detail}，新增待确认维度，先安排补测`
        : `${detail}，置信度未提升，先安排补测`,
    direction: current.uncertaintyCount > previous.uncertaintyCount ? 'UP' : 'FLAT',
  };
}

/**
 * 是否建议改计划：同一方向连续 2 周 ≥15%，或本周样本 ≥N 且单周 ≥15%。
 *
 * 只针对「正确率 / 延迟复测保持率」两条趋势指标 —— 待确认维度变化是诊断信号，
 * 不是预算/配比信号。
 */
function decideChange(
  current: WeeklyDeltaSnapshot,
  previous: WeeklyDeltaSnapshot | null,
  prior: WeeklyDeltaSnapshot | null | undefined,
): { recommended: boolean; reason: string } {
  if (!previous) return { recommended: false, reason: '没有上周基线' };

  const series: {
    label: string;
    cur: number | null;
    prev: number | null;
    prior: number | null;
    sampleOk: boolean;
  }[] = [
    {
      label: '正确率',
      cur: current.accuracy,
      prev: previous.accuracy,
      prior: prior?.accuracy ?? null,
      sampleOk: current.accuracySample >= WEEKLY_DELTA_SAMPLE_N,
    },
    {
      label: '延迟复测保持率',
      cur: current.retestKeepRate,
      prev: previous.retestKeepRate,
      prior: prior?.retestKeepRate ?? null,
      sampleOk: current.retestSample >= WEEKLY_DELTA_SAMPLE_N,
    },
  ];

  for (const row of series) {
    const recent = metricMove(row.cur, row.prev);
    if (!recent.significant) continue;

    if (row.sampleOk) {
      return {
        recommended: true,
        reason: `本周「${row.label}」样本 ${WEEKLY_DELTA_SAMPLE_N}+ 且单周变化 ${signedRelativeText(recent)}`,
      };
    }
    const earlier = metricMove(row.prev, row.prior);
    if (earlier.significant && earlier.direction === recent.direction) {
      return {
        recommended: true,
        reason: `「${row.label}」连续 2 周同向变化（${signedRelativeText(earlier)} → ${signedRelativeText(recent)}）`,
      };
    }
  }

  return { recommended: false, reason: '' };
}

/** 本周正确率的「波动」文案（阈值说明用）；无样本时明确说无样本。 */
function accuracyFluctuationText(
  current: WeeklyDeltaSnapshot,
  previous: WeeklyDeltaSnapshot | null,
): string {
  if (!previous) return '无上周基线';
  if (current.accuracy === null || previous.accuracy === null) return '本周无判定样本';
  return signedRelativeText(metricMove(current.accuracy, previous.accuracy));
}

function buildSuggestions(
  current: WeeklyDeltaSnapshot,
  previous: WeeklyDeltaSnapshot,
): WeeklyDeltaSuggestion[] {
  const suggestions: WeeklyDeltaSuggestion[] = [];
  const accuracy = metricMove(current.accuracy, previous.accuracy);
  const retest = metricMove(current.retestKeepRate, previous.retestKeepRate);

  if (accuracy.direction === 'DOWN' && accuracy.significant) {
    suggestions.push({
      kind: 'ADJUST_FOCUS',
      note: '下周把核心时段集中到正确率下滑的技能，先做针对性练习再做新内容。',
      basis: `正确率 ${accuracyText(previous.accuracy)} → ${accuracyText(
        current.accuracy,
      )}（${signedRelativeText(accuracy)}）`,
    });
  } else if (accuracy.direction === 'UP' && accuracy.significant) {
    suggestions.push({
      kind: 'KEEP',
      note: '维持当前技能配比，正确率连续改善时不要加量，先把效果稳住。',
      basis: `正确率 ${accuracyText(previous.accuracy)} → ${accuracyText(
        current.accuracy,
      )}（${signedRelativeText(accuracy)}）`,
    });
  }

  if (retest.direction === 'DOWN' && retest.significant) {
    suggestions.push({
      kind: 'ADJUST_FOCUS',
      note: '下周增加延迟复测（D7/D14）的占比，优先保住已掌握的内容。',
      basis: `延迟复测保持率 ${accuracyText(previous.retestKeepRate)} → ${accuracyText(
        current.retestKeepRate,
      )}（${signedRelativeText(retest)}）`,
    });
  }

  if (current.activeDays < 5) {
    suggestions.push({
      kind: 'ADJUST_TIME',
      note: '下周先保证 5 天有效学习，再谈加量；预算按实际可用时间设置。',
      basis: `本周有效学习 ${current.activeDays} 天`,
    });
  }

  return suggestions.slice(0, 2);
}

/**
 * 两周（含可选上上周）指标 → 周复盘三类结论 + 改计划建议。
 *
 * 纯函数：同一输入必得同一输出；不读库、不看时钟。
 */
export function buildWeeklyDelta(input: WeeklyDeltaInput): WeeklyDeltaResult {
  const { current, previous } = input;
  const prior = input.prior ?? null;

  if (current.activeDays < WEEKLY_DELTA_MIN_ACTIVE_DAYS) {
    return {
      sampleInsufficient: true,
      headline: `本周有效学习 ${current.activeDays} 天（不足 ${WEEKLY_DELTA_MIN_ACTIVE_DAYS} 天）：样本不足，暂不下结论，仅记录。`,
      improved: [],
      unresolved: [],
      needsDiagnosis: [],
      changeRecommended: false,
      thresholdNote: `有效学习 ${current.activeDays} 天，低于 ${WEEKLY_DELTA_MIN_ACTIVE_DAYS} 天样本门槛，不生成调整建议（避免基于噪声改计划）。`,
      suggestions: [],
    };
  }

  if (!previous) {
    return {
      sampleInsufficient: false,
      headline: '没有上周基线：本周仅记录，暂不做趋势判断。',
      improved: [],
      unresolved: [],
      needsDiagnosis: [
        {
          metric: 'ACCURACY',
          category: 'NEEDS_DIAGNOSIS',
          label: '上周基线',
          detail: '上周没有指标快照，无法计算变化；下周起可对比。',
          direction: 'NA',
        },
      ],
      changeRecommended: false,
      thresholdNote: '无上周期基线，无可对比的趋势；下周起再判断是否调整计划。',
      suggestions: [],
    };
  }

  const items: WeeklyDeltaItem[] = [accuracyItem(current, previous), retestItem(current, previous)];
  const uncertainty = uncertaintyItem(current, previous);
  if (uncertainty) items.push(uncertainty);

  const improved = items.filter((item) => item.category === 'IMPROVED');
  const unresolved = items.filter((item) => item.category === 'UNRESOLVED');
  const needsDiagnosis = items.filter((item) => item.category === 'NEEDS_DIAGNOSIS');

  const change = decideChange(current, previous, prior);
  const fluctuation = accuracyFluctuationText(current, previous);
  const thresholdNote = change.recommended
    ? `本周正确率波动 ${fluctuation}；${change.reason}，已达改计划阈值（连续 2 周 ≥${Math.round(
        WEEKLY_DELTA_TREND_THRESHOLD * 100,
      )}% 或样本 ≥${WEEKLY_DELTA_SAMPLE_N}），可调整下周计划。`
    : `本周正确率波动 ${fluctuation}，未达改计划阈值（需连续 2 周 ≥${Math.round(
        WEEKLY_DELTA_TREND_THRESHOLD * 100,
      )}% 或样本 ≥${WEEKLY_DELTA_SAMPLE_N}），故计划不变更。`;

  return {
    sampleInsufficient: false,
    headline: `本周 ${improved.length} 项有证据改善，${unresolved.length} 项未解决，${needsDiagnosis.length} 项需进一步诊断。`,
    improved,
    unresolved,
    needsDiagnosis,
    changeRecommended: change.recommended,
    thresholdNote,
    suggestions: change.recommended ? buildSuggestions(current, previous) : [],
  };
}