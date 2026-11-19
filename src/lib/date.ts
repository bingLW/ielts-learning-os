/**
 * 唯一日期入口。
 *
 * 设计口径（架构 §0 / §9）：
 * - 业务日期一律 `YYYY-MM-DD` 字符串，时刻一律 `DateTime`；
 * - 时区固定 Asia/Singapore（UTC+8，无夏令时），**不引入 tz 库**；
 * - 所有「日期加减 / 星期 / ISO 周」都基于 UTC 正午锚点的纯字符串运算，
 *   避免任何本地时区漂移；
 * - 业务代码禁止 `new Date().getDate()` 之类直算，一律调用本模块。
 */

import { TZ_OFFSET_MINUTES } from './constants';

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `YYYY-MM-DD` 是否合法（同时校验真实存在的日历日，例如 2025-02-30 非法）。 */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

/** 把 `YYYY-MM-DD` 解析成「UTC 零点」毫秒数（纯日历运算，不含时区语义）。 */
export function parseDateMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/** 把「UTC 零点」毫秒数写回 `YYYY-MM-DD`。 */
export function fromMs(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 日期加天数（可为负）。`addDays('2025-03-31', 1) === '2025-04-01'`。 */
export function addDays(date: string, days: number): string {
  return fromMs(parseDateMs(date) + Math.round(days) * MS_PER_DAY);
}

/** `to - from` 的天数差（正数表示 to 在 from 之后）。 */
export function diffDays(from: string, to: string): number {
  return Math.round((parseDateMs(to) - parseDateMs(from)) / MS_PER_DAY);
}

/** 给定时刻对应的业务日期（Asia/Singapore 自然日）。 */
export function toBusinessDate(instant: Date): string {
  const shifted = new Date(instant.getTime() + TZ_OFFSET_MINUTES * MS_PER_MINUTE);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate(),
  )}`;
}

/** 今天的业务日期。参数只为测试注入，业务代码不要传。 */
export function today(now: Date = new Date()): string {
  return toBusinessDate(now);
}

/** 业务时刻 → 真实 UTC 时刻（`YYYY-MM-DD` + `HH:mm` 视为 +08:00 墙上时间）。 */
export function toUtcInstant(date: string, time = '00:00'): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0) - TZ_OFFSET_MINUTES * MS_PER_MINUTE);
}

/** 业务日的 24:00（= 次日 00:00）对应的真实时刻。 */
export function endOfBusinessDay(date: string): Date {
  return toUtcInstant(addDays(date, 1));
}

/** 星期几（0 = 周日，与 `Date.getDay()` 一致）。 */
export function dayOfWeek(date: string): number {
  return new Date(parseDateMs(date)).getUTCDay();
}

/** ISO 周起始（周一）。 */
export function startOfIsoWeek(date: string): string {
  const dow = dayOfWeek(date);
  const shift = dow === 0 ? -6 : 1 - dow;
  return addDays(date, shift);
}

/** 指定日期所属 ISO 周的范围。 */
export function weekRange(date: string): { weekStart: string; weekEnd: string } {
  const weekStart = startOfIsoWeek(date);
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

/** ISO 周年 + 周序号。跨年边界（如 2026-01-01 属 2025 年第 53 周附近）由此保证正确。 */
export function isoWeek(date: string): { isoYear: number; isoWeek: number } {
  const cursor = new Date(parseDateMs(date));
  // 移到本周的周四：周四所在年份即 ISO 周年
  const dow = (cursor.getUTCDay() + 6) % 7; // 周一 = 0
  cursor.setUTCDate(cursor.getUTCDate() - dow + 3);
  const isoYear = cursor.getUTCFullYear();
  // 该年第一个周四
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3);
  const week = 1 + Math.round((cursor.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return { isoYear, isoWeek: week };
}

/** 闭区间日期列表（含两端）。 */
export function listDateRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const span = diffDays(startDate, endDate);
  if (span < 0) return out;
  for (let i = 0; i <= span; i += 1) {
    out.push(addDays(startDate, i));
  }
  return out;
}

/** 最近 n 天的日期列表（含今天，升序）。 */
export function lastNDays(n: number, endDate: string): string[] {
  return listDateRange(addDays(endDate, -(n - 1)), endDate);
}

/** 月视图网格：返回 6×7 的日期矩阵（周一开头），越界日补相邻月日期。 */
export function monthGrid(year: number, month: number): string[][] {
  const first = `${year}-${pad2(month)}-01`;
  const gridStart = startOfIsoWeek(first);
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w += 1) {
    const row: string[] = [];
    for (let d = 0; d < 7; d += 1) {
      row.push(addDays(gridStart, w * 7 + d));
    }
    weeks.push(row);
  }
  return weeks;
}

/** 跨零点拆分的单条结果。 */
export interface DaySplit {
  date: string;
  minutes: number;
}

/**
 * 按分钟占比把一段计时拆到两个自然日，保证 `Σminutes === activeMinutes`。
 *
 * 业务日期切换点固定为该日的 +08:00 00:00，所以「23:50 开始、计时 20 分钟」
 * 会拆成 10 + 10，而不是整段记到某一天。
 *
 * 非法 ISO（脏数据）→ 返回**空数组**：调用方据此「不落 DaySplit」，
 * 绝不凭空记到「今天」（那会把脏数据的时长算进今天的净时长，缺陷 D11）。
 */
export function splitAcrossMidnight(startedAtIso: string, minutes: number): DaySplit[] {
  const total = Math.max(0, Math.round(minutes));
  const startInstant = new Date(startedAtIso);
  if (Number.isNaN(startInstant.getTime())) {
    return [];
  }
  const out: DaySplit[] = [];
  let cursorMs = startInstant.getTime();
  let remaining = total;

  // 单次计时段不可能跨超过 3 个自然日，guard 只做防御
  for (let guard = 0; guard < 4 && remaining > 0; guard += 1) {
    const cursorDate = toBusinessDate(new Date(cursorMs));
    const nextMidnightMs = endOfBusinessDay(cursorDate).getTime();
    const minutesLeftInDay = Math.max(0, Math.floor((nextMidnightMs - cursorMs) / MS_PER_MINUTE));
    if (minutesLeftInDay <= 0) {
      cursorMs = nextMidnightMs;
      continue;
    }
    const take = Math.min(remaining, minutesLeftInDay);
    out.push({ date: cursorDate, minutes: take });
    remaining -= take;
    cursorMs = nextMidnightMs;
  }

  if (remaining > 0) {
    const lastDate = out.length > 0 ? out[out.length - 1].date : toBusinessDate(startInstant);
    out.push({ date: lastDate, minutes: remaining });
  }

  if (out.length === 0) {
    return [{ date: toBusinessDate(startInstant), minutes: 0 }];
  }
  return out;
}

/** 当前时刻的 ISO 字符串（用于 DTO 序列化）。 */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
