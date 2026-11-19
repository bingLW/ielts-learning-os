/**
 * 展示格式化。所有数字统一四舍五入，所有「无数据」统一显示 `—`。
 *
 * 两种时长文案并存是刻意的：
 * - `formatMinutes`  → 紧凑格式 `3h 25m`，用于表格、图表轴、紧凑卡片；
 * - `formatDurationZh` → 中文格式 `3 小时 25 分`，用于正文与详情。
 */

/** 空值占位符。禁止用 `0` 冒充缺失数据。 */
export const EMPTY_PLACEHOLDER = '—';

/** 保留 n 位小数（四舍五入）。 */
export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 紧凑时长：`205 → '3h 25m'`，`60 → '1h'`，`0 → '0m'`。 */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return EMPTY_PLACEHOLDER;
  }
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/** 中文时长：`135 → '2 小时 15 分'`，`45 → '45 分'`，`60 → '1 小时'`。 */
export function formatDurationZh(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return EMPTY_PLACEHOLDER;
  }
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins} 分`;
  if (mins === 0) return `${hours} 小时`;
  return `${hours} 小时 ${mins} 分`;
}

/**
 * 百分比：`0.834 → '83%'`；`null → '—'`。
 * 输入必须是 0..1 的比率；超出范围的脏数据先夹紧再格式化。
 */
export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_PLACEHOLDER;
  }
  const clamped = Math.min(1, Math.max(0, value));
  return `${round(clamped * 100, digits)}%`;
}

/** 比率但以 0..100 数值给入（例如 83.4 表示 83.4%）。 */
export function formatPercentOf100(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_PLACEHOLDER;
  }
  return `${round(Math.min(100, Math.max(0, value)), digits)}%`;
}

/** 雅思 Band 分：一位小数，`6 → '6.0'`。 */
export function formatBand(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_PLACEHOLDER;
  }
  return round(value, 1).toFixed(1);
}

/** 分数：`{correct}/{total}`，`total=0` 时显示 `—`。 */
export function formatQuestionRatio(
  correct: number | null | undefined,
  total: number | null | undefined,
): string {
  if (!total) return EMPTY_PLACEHOLDER;
  return `${correct ?? 0}/${total}`;
}

/** 带符号的差值文案：`+18 分` / `-5 分` / `持平`。 */
export function formatDelta(value: number | null | undefined, suffix = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_PLACEHOLDER;
  }
  const rounded = Math.round(value);
  if (rounded === 0) return '持平';
  const unit = suffix ? ` ${suffix}` : '';
  return rounded > 0 ? `+${rounded}${unit}` : `${rounded}${unit}`;
}

/** 净时长分钟差（本周 vs 上周），单位「分」。 */
export function formatMinutesDelta(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return '与上周持平';
  const abs = formatDurationZh(Math.abs(rounded));
  return rounded > 0 ? `较上周 +${abs}` : `较上周 -${abs}`;
}

/** 安全取百分比数值（0..100），供图表数据点使用；无数据返回 `null`。 */
export function percentValue(ratio: number | null | undefined): number | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return null;
  return round(Math.min(1, Math.max(0, ratio)) * 100, 1);
}

/** 截断长文本。 */
export function truncate(text: string | null | undefined, max = 60): string {
  if (!text) return EMPTY_PLACEHOLDER;
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/** 日期 + 周次文案。 */
export function formatDateRange(startDate: string, endDate: string): string {
  return `${startDate} ~ ${endDate}`;
}
