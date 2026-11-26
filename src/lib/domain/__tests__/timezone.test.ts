import { describe, expect, it } from 'vitest';
import { updateProfileSchema } from '../../schema/settings';
import {
  endOfBusinessDay,
  formatBusinessDateTime,
  isValidTimeZone,
  splitAcrossMidnight,
  toBusinessDate,
  toUtcInstant,
  today,
  weekRange,
} from '../../date';

describe('IANA 业务时区', () => {
  it('校验真实时区并拒绝伪造名称', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('UTC+08:00')).toBe(false);
    expect(isValidTimeZone('Not/A_Zone')).toBe(false);
    expect(() => today(new Date(), 'Not/A_Zone')).toThrow('无效时区');
  });

  it('设置契约接受 IANA 时区并拒绝非法名称', () => {
    const base = { targetBandOverall: 6.5, dailyMinutes: 240, weeklyReviewDow: 0 };
    expect(updateProfileSchema.safeParse({ ...base, timezone: 'America/New_York' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ ...base, timezone: 'UTC+08:00' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ ...base, timezone: '' }).success).toBe(false);
  });

  it('同一时刻按用户时区归属不同业务日', () => {
    const instant = new Date('2026-11-26T23:30:00.000Z');
    expect(toBusinessDate(instant, 'Asia/Shanghai')).toBe('2026-11-27');
    expect(toBusinessDate(instant, 'America/Los_Angeles')).toBe('2026-11-26');
    expect(formatBusinessDateTime(instant.toISOString(), 'Asia/Shanghai')).toBe(
      '2026-11-27 07:30',
    );
  });

  it('夏令时春季缺失时刻明确拒绝，不静默移位', () => {
    expect(toUtcInstant('2026-03-08', '01:59', 'America/New_York').toISOString()).toBe(
      '2026-03-08T06:59:00.000Z',
    );
    expect(() => toUtcInstant('2026-03-08', '02:30', 'America/New_York')).toThrow('不存在');
    expect(toUtcInstant('2026-03-08', '03:00', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
  });

  it('夏令时秋季重复时刻取较早的一次', () => {
    expect(toUtcInstant('2026-11-01', '01:30', 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('日界使用当地午夜，春季日 23 小时、秋季日 25 小时', () => {
    expect(
      endOfBusinessDay('2026-03-08', 'America/New_York').getTime() -
        toUtcInstant('2026-03-08', '00:00', 'America/New_York').getTime(),
    ).toBe(23 * 60 * 60 * 1000);
    expect(
      endOfBusinessDay('2026-11-01', 'America/New_York').getTime() -
        toUtcInstant('2026-11-01', '00:00', 'America/New_York').getTime(),
    ).toBe(25 * 60 * 60 * 1000);
  });

  it('周边界按用户业务日归属，而不是 UTC 日期', () => {
    const instant = new Date('2026-11-29T18:30:00.000Z');
    const businessDate = today(instant, 'Asia/Shanghai');
    expect(businessDate).toBe('2026-11-30');
    expect(weekRange(businessDate)).toEqual({ weekStart: '2026-11-30', weekEnd: '2026-12-06' });
    expect(today(instant, 'America/Phoenix')).toBe('2026-11-29');
  });

  it('跨午夜按真实日界拆分且不丢分钟', () => {
    const spring = splitAcrossMidnight('2026-03-09T03:30:00.000Z', 60, 'America/New_York');
    expect(spring).toEqual([
      { date: '2026-03-08', minutes: 30 },
      { date: '2026-03-09', minutes: 30 },
    ]);
    const fall = splitAcrossMidnight('2026-11-02T04:30:00.000Z', 60, 'America/New_York');
    expect(fall).toEqual([
      { date: '2026-11-01', minutes: 30 },
      { date: '2026-11-02', minutes: 30 },
    ]);
    expect(spring.reduce((sum, row) => sum + row.minutes, 0)).toBe(60);
    expect(fall.reduce((sum, row) => sum + row.minutes, 0)).toBe(60);
  });
});
