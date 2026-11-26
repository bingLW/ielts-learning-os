/**
 * 唯一日期入口。
 *
 * 设计口径（架构 §0 / §9）：
 * - 业务日期一律 `YYYY-MM-DD` 字符串，时刻一律 `DateTime`；
 * - 时刻换算接收 IANA 时区；默认值仅为首次配置的 Asia/Singapore；
 * - 所有「日期加减 / 星期 / ISO 周」都基于 UTC 正午锚点的纯字符串运算，
 *   避免任何本地时区漂移；
 * - 业务代码禁止 `new Date().getDate()` 之类直算，一律调用本模块。
 */

import { TZ_NAME } from './constants';

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

/** IANA 时区是否可用；拒绝客户端伪造时区名。 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return (wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000) / MS_PER_MINUTE;
}

/** 给定时刻对应的指定 IANA 时区自然日。 */
export function toBusinessDate(instant: Date, timeZone: string = TZ_NAME): string {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`无效时区：${timeZone}`);
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** 今天的业务日期；now 与 timeZone 可由调用方或测试显式注入。 */
export function today(now: Date = new Date(), timeZone: string = TZ_NAME): string {
  return toBusinessDate(now, timeZone);
}

/**
 * 业务墙上时刻 → UTC 时刻。夏令时重复时刻取较早的一次；不存在的时刻抛错，
 * 避免把 02:30 静默移到另一小时而污染学习记录。
 */
export function toUtcInstant(date: string, time = '00:00', timeZone: string = TZ_NAME): Date {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`无效时区：${timeZone}`);
  if (!isValidDateString(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new RangeError(`无效业务时刻：${date} ${time}`);
  }
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  if (hh > 23 || mm > 59) throw new RangeError(`无效业务时刻：${date} ${time}`);
  const desiredAsUtc = Date.UTC(y, m - 1, d, hh, mm);
  const offsets = new Set<number>();
  for (const shift of [-3, -2, -1, 0, 1, 2, 3]) {
    offsets.add(offsetMinutes(new Date(desiredAsUtc + shift * MS_PER_DAY), timeZone));
  }
  const matches = [...offsets]
    .map((offset) => desiredAsUtc - offset * MS_PER_MINUTE)
    .filter((candidate) => {
      const parts = zonedParts(new Date(candidate), timeZone);
      return (
        Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) === desiredAsUtc
      );
    })
    .sort((a, b) => a - b);
  if (matches.length === 0) throw new RangeError(`该时刻在 ${timeZone} 不存在：${date} ${time}`);
  return new Date(matches[0]);
}

/** 业务日的 24:00（= 次日 00:00）对应的真实时刻。 */
export function endOfBusinessDay(date: string, timeZone: string = TZ_NAME): Date {
  return toUtcInstant(addDays(date, 1), '00:00', timeZone);
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
 * 业务日期切换点由指定 IANA 时区的次日 00:00 决定，因此夏令时日的 23/25 小时
 * 也按真实经过时长拆分；「23:50 开始、计时 20 分钟」会拆成 10 + 10。
 *
 * 非法 ISO（脏数据）→ 返回**空数组**：调用方据此「不落 DaySplit」，
 * 绝不凭空记到「今天」（那会把脏数据的时长算进今天的净时长，缺陷 D11）。
 */
export function splitAcrossMidnight(
  startedAtIso: string,
  minutes: number,
  timeZone: string = TZ_NAME,
): DaySplit[] {
  const total = Math.max(0, Math.round(minutes));
  const startInstant = new Date(startedAtIso);
  if (Number.isNaN(startInstant.getTime())) {
    return [];
  }
  const out: DaySplit[] = [];
  let cursorMs = startInstant.getTime();
  let remaining = total;

  // 单次计时段不可能跨超过 3 个自然日，guard 只做防御
  for (let guard = 0; guard < 6 && remaining > 0; guard += 1) {
    const cursorDate = toBusinessDate(new Date(cursorMs), timeZone);
    const nextMidnightMs = endOfBusinessDay(cursorDate, timeZone).getTime();
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
    const lastDate = out.length > 0 ? out[out.length - 1].date : toBusinessDate(startInstant, timeZone);
    out.push({ date: lastDate, minutes: remaining });
  }

  if (out.length === 0) {
    return [{ date: toBusinessDate(startInstant, timeZone), minutes: 0 }];
  }
  return out;
}

/** 当前时刻的 ISO 字符串（用于 DTO 序列化）。 */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/**
 * 时刻 → 指定 IANA 时区墙上时间 `YYYY-MM-DD HH:mm`。
 *
 * DTO 里的时刻是 UTC ISO 字符串，直接截断会显示 UTC 时间；
 * 展示层统一走这里，避免各页面各写一套。
 */
export function formatBusinessDateTime(iso: string, timeZone: string = TZ_NAME): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}
