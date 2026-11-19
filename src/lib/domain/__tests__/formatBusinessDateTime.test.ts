import { describe, expect, it } from 'vitest';
import { formatBusinessDateTime } from '../../date';

describe('formatBusinessDateTime', () => {
  it('UTC 上午按 +08:00 显示', () => {
    expect(formatBusinessDateTime('2026-11-19T10:24:00.000Z')).toBe('2026-11-19 18:24');
  });

  it('跨 UTC 零点时业务日期顺延', () => {
    expect(formatBusinessDateTime('2026-11-19T17:05:00.000Z')).toBe('2026-11-20 01:05');
  });

  it('非法输入原样返回', () => {
    expect(formatBusinessDateTime('not-a-date')).toBe('not-a-date');
  });
});
