/**
 * 复习调度：点数、去重、补测、追加、掌握判定、4 点上限。
 */

import { describe, expect, it } from 'vitest';
import {
  appendAfterRetest,
  generateReviewPoints,
  nextLowFreqDate,
  shouldMarkMastered,
} from '../review';

describe('generateReviewPoints', () => {
  const base = {
    d0: '2025-03-01',
    today: '2025-03-01',
    totalQuestions: 10,
    existing: [],
  };

  it('GREEN 不生成结构化复习点', () => {
    expect(generateReviewPoints({ ...base, color: 'GREEN' })).toEqual([]);
  });

  it('PENDING 不排程', () => {
    expect(generateReviewPoints({ ...base, color: 'PENDING' })).toEqual([]);
  });

  it('YELLOW 生成 D1 / D3 / D7 三个点', () => {
    const points = generateReviewPoints({ ...base, color: 'YELLOW' });
    expect(points.map((point) => point.intervalCode)).toEqual(['D1', 'D3', 'D7']);
    expect(points.map((point) => point.dueDate)).toEqual(['2025-03-02', '2025-03-04', '2025-03-08']);
  });

  it('RED 生成 D1 / D3 / D7 / D14 四个点', () => {
    const points = generateReviewPoints({ ...base, color: 'RED' });
    expect(points.map((point) => point.intervalCode)).toEqual(['D1', 'D3', 'D7', 'D14']);
  });

  it('YELLOW 且 total<5 → 追加 MANUAL 补测（+2 天）', () => {
    const points = generateReviewPoints({ ...base, color: 'YELLOW', totalQuestions: 3 });
    const manual = points.find((point) => point.intervalCode === 'MANUAL');
    expect(manual).toBeDefined();
    expect(manual?.dueDate).toBe('2025-03-03');
  });

  it('已存在同档位 PENDING 点 → 不重复生成', () => {
    const points = generateReviewPoints({
      ...base,
      color: 'YELLOW',
      existing: [{ intervalCode: 'D1', dueDate: '2025-03-02', status: 'PENDING' }],
    });
    expect(points.map((point) => point.intervalCode)).toEqual(['D3', 'D7']);
  });

  it('新点不落在过去：dueDate = max(d0+n, today)', () => {
    const points = generateReviewPoints({
      ...base,
      d0: '2025-01-01',
      today: '2025-03-10',
      color: 'RED',
    });
    expect(points.every((point) => point.dueDate >= '2025-03-10')).toBe(true);
  });

  it('未完成点数已达 4 → 不再新增', () => {
    const points = generateReviewPoints({
      ...base,
      color: 'RED',
      existing: [
        { intervalCode: 'D1', dueDate: '2025-03-02', status: 'PENDING' },
        { intervalCode: 'D3', dueDate: '2025-03-04', status: 'PENDING' },
        { intervalCode: 'D7', dueDate: '2025-03-08', status: 'PENDING' },
        { intervalCode: 'D14', dueDate: '2025-03-15', status: 'PENDING' },
      ],
    });
    expect(points).toEqual([]);
  });
});

describe('appendAfterRetest', () => {
  const base = { d0: '2025-03-01', existing: [] };

  it('D3 复测仍 YELLOW → 追加 D7 与 D14', () => {
    const points = appendAfterRetest({
      ...base,
      today: '2025-03-04',
      retestInterval: 'D3',
      result: 'YELLOW',
    });
    expect(points.map((point) => point.intervalCode)).toEqual(['D7', 'D14']);
  });

  it('D7 复测仍 RED → 追加 D14 / D21 / D30', () => {
    const points = appendAfterRetest({
      ...base,
      today: '2025-03-08',
      retestInterval: 'D7',
      result: 'RED',
    });
    expect(points.map((point) => point.intervalCode)).toEqual(['D14', 'D21', 'D30']);
  });

  it('复测 GREEN → 不追加', () => {
    expect(
      appendAfterRetest({
        ...base,
        today: '2025-03-04',
        retestInterval: 'D3',
        result: 'GREEN',
      }),
    ).toEqual([]);
  });
});

describe('shouldMarkMastered', () => {
  it('连续两次 GREEN 且间隔 ≥7 天 → 掌握', () => {
    const result = shouldMarkMastered({
      reviews: [
        { reviewDate: '2025-03-01', color: 'GREEN' },
        { reviewDate: '2025-03-09', color: 'GREEN' },
      ],
    });
    expect(result.mastered).toBe(true);
    expect(result.anchorGapDays).toBe(8);
  });

  it('间隔 <7 天 → 未掌握', () => {
    const result = shouldMarkMastered({
      reviews: [
        { reviewDate: '2025-03-01', color: 'GREEN' },
        { reviewDate: '2025-03-04', color: 'GREEN' },
      ],
    });
    expect(result.mastered).toBe(false);
  });

  it('最后一次是 YELLOW → streak 归零', () => {
    const result = shouldMarkMastered({
      reviews: [
        { reviewDate: '2025-03-01', color: 'GREEN' },
        { reviewDate: '2025-03-09', color: 'GREEN' },
        { reviewDate: '2025-03-12', color: 'YELLOW' },
      ],
    });
    expect(result.mastered).toBe(false);
    expect(result.greenStreak).toBe(0);
  });

  it('低频池 +30 天', () => {
    expect(nextLowFreqDate('2025-03-31')).toBe('2025-04-30');
  });
});
