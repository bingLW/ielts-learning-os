/**
 * 被测文件：src/lib/domain/review.ts
 * 规则来源：PRD §6.3（D0=首测日、YELLOW→D1/D3/D7、RED→D1/D3/D7/D14、只追加不改期、
 *           逾期不改期、未完成点上限 4、连续 2 次绿灯且间隔≥7 天掌握、掌握后 +30 天低频池）
 *           + PRD Q2（题量不足 +2 天补测）。
 *
 * 本文件的主线是「日期必须全部来自入参」：所有用例的 d0 都放在 2020 年，
 * 一旦实现里偷偷用了系统时间，断言会立刻红。
 */

import { describe, expect, it } from 'vitest';
import {
  appendAfterRetest,
  colorDistribution,
  generateReviewPoints,
  nextLowFreqDate,
  overdueDays,
  shouldMarkMastered,
} from '../review';
import type { ExistingPoint, IntervalCode, PlannedPoint } from '../../types';

/** 只取档位序列，便于「一眼看出少了哪一档」。 */
function codesOf(points: PlannedPoint[]): IntervalCode[] {
  return points.map((point) => point.intervalCode);
}

function pending(intervalCode: IntervalCode, dueDate: string): ExistingPoint {
  return { intervalCode, dueDate, status: 'PENDING' };
}

describe('generateReviewPoints —— 点数与起点日期', () => {
  it('黄灯生成 D1/D3/D7 三个点，日期基于 d0（不是系统时间）', () => {
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'YELLOW',
      totalQuestions: 10,
      existing: [],
    });
    expect(codesOf(points), '黄灯必须恰好 D1/D3/D7 三档').toEqual(['D1', 'D3', 'D7']);
    expect(
      points.map((point) => point.dueDate),
      '日期必须是 d0 + 1/3/7 天；若出现「今天」说明实现里用了系统时间',
    ).toEqual(['2020-01-02', '2020-01-04', '2020-01-08']);
  });

  it('红灯生成 D1/D3/D7/D14 四个点，日期基于 d0', () => {
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'RED',
      totalQuestions: 10,
      existing: [],
    });
    expect(codesOf(points), '红灯必须恰好 D1/D3/D7/D14 四档').toEqual(['D1', 'D3', 'D7', 'D14']);
    expect(
      points.map((point) => point.dueDate),
      'D14 = d0 + 14 天',
    ).toEqual(['2020-01-02', '2020-01-04', '2020-01-08', '2020-01-15']);
  });

  it('绿灯 / 待判定不生成结构化复习点', () => {
    const base = { d0: '2020-01-01', today: '2020-01-01', totalQuestions: 10, existing: [] };
    expect(generateReviewPoints({ ...base, color: 'GREEN' }), '绿灯不进结构化复习').toEqual([]);
    expect(generateReviewPoints({ ...base, color: 'PENDING' }), '无数据不排程').toEqual([]);
  });

  it('题量不足的黄灯：MANUAL 补测点排在 D1 之后、D3 之前', () => {
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'YELLOW',
      totalQuestions: 3,
      existing: [],
    });
    expect(
      codesOf(points),
      '按 dueDate 升序：D1(+1) → MANUAL(+2) → D3(+3) → D7(+7)',
    ).toEqual(['D1', 'MANUAL', 'D3', 'D7']);
  });

  it('已存在同档位 PENDING 点 → 不重复生成，但其它档位照常补', () => {
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'YELLOW',
      totalQuestions: 10,
      existing: [pending('D1', '2020-01-02')],
    });
    expect(codesOf(points), 'D1 已存在且未完成，只补 D3/D7').toEqual(['D3', 'D7']);
  });

  it('同档位已完成（DONE）不阻止重新生成', () => {
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'YELLOW',
      totalQuestions: 10,
      existing: [{ intervalCode: 'D1', dueDate: '2020-01-02', status: 'DONE' }],
    });
    expect(codesOf(points).includes('D1'), '已完成的 D1 不算重复，应可重新排程').toBe(true);
  });

  it('已存在 MANUAL PENDING → 不再追加补测点', () => {
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'YELLOW',
      totalQuestions: 3,
      existing: [pending('MANUAL', '2020-01-03')],
    });
    expect(codesOf(points), 'MANUAL 去重生效，只剩 D1/D3/D7').toEqual(['D1', 'D3', 'D7']);
  });

  it('预估分钟可覆盖，非法覆盖值回落到默认值', () => {
    const overridden = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'YELLOW',
      totalQuestions: 10,
      existing: [],
      estMinutesByInterval: { D1: 99.4 },
    });
    const d1 = overridden.find((point) => point.intervalCode === 'D1');
    expect(d1?.estMinutes, '覆盖值应四舍五入生效').toBe(99);

    const zeroOverride = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'YELLOW',
      totalQuestions: 10,
      existing: [],
      estMinutesByInterval: { D1: 0 },
    });
    const d1Default = zeroOverride.find((point) => point.intervalCode === 'D1');
    expect(d1Default?.estMinutes, '0 分钟覆盖非法，必须回落默认 5 分钟').toBe(5);
  });
});

describe('generateReviewPoints —— 逾期点不消失、不改期', () => {
  it('D1 逾期未完成：不消失、不重复、也不让后续点顺延', () => {
    const existing: ExistingPoint[] = [pending('D1', '2020-01-02')];
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-03',
      color: 'YELLOW',
      totalQuestions: 10,
      existing,
    });
    expect(codesOf(points), '逾期的 D1 不应被重新生成，也不应被删除').toEqual(['D3', 'D7']);
    expect(
      points.map((point) => point.dueDate),
      'D3 没做不能让 D7 后移：两天都必须是 d0 的自然间隔日',
    ).toEqual(['2020-01-04', '2020-01-08']);
    expect(existing, '入参数组不得被就地修改').toEqual([pending('D1', '2020-01-02')]);
  });

  it('入参数组不被修改（函数必须是纯的）', () => {
    const existing: ExistingPoint[] = [pending('D3', '2020-01-04')];
    const snapshot = JSON.parse(JSON.stringify(existing)) as ExistingPoint[];
    generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'RED',
      totalQuestions: 10,
      existing,
    });
    expect(existing, '不得 mutate existing 数组元素').toEqual(snapshot);
  });

  it('today 已越过自然间隔日时，新点被 clamp 到 today（已确认实现）', () => {
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-10',
      color: 'YELLOW',
      totalQuestions: 10,
      existing: [pending('D1', '2020-01-02')],
    });
    expect(
      points.map((point) => point.dueDate),
      '新点绝不落在过去：D3/D7 的自然日已过去，均被 clamp 到 today（见缺陷 D6）',
    ).toEqual(['2020-01-10', '2020-01-10']);
  });

  it('未完成点已满 4 个 → 不再新增', () => {
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-01-01',
      color: 'RED',
      totalQuestions: 10,
      existing: [
        pending('D1', '2020-01-02'),
        pending('D3', '2020-01-04'),
        pending('D7', '2020-01-08'),
        pending('D14', '2020-01-15'),
      ],
    });
    expect(points, '4 个未完成点已占满名额').toEqual([]);
  });

  it('逾期 PENDING 不应永久占满 4 个名额（PRD：上限指「未完成的未来点」）', () => {
    const points = generateReviewPoints({
      d0: '2020-01-01',
      today: '2020-03-01',
      color: 'RED',
      totalQuestions: 10,
      // 4 个早已逾期、本该被 SKIP 的旧点
      existing: [
        pending('D1', '2020-01-02'),
        pending('D3', '2020-01-04'),
        pending('D7', '2020-01-08'),
        pending('D21', '2020-01-22'),
      ],
    });
    expect(
      codesOf(points),
      'D3（已修复）：4 个名额只统计「未完成的未来点」，逾期点不占名额，D14 必须排得上',
    ).toContain('D14');
  });
});

describe('appendAfterRetest —— 只追加、不改期', () => {
  const base = { d0: '2020-01-01', existing: [] };

  it('D1 复测仍黄灯 → 沿阶梯追加 D3 与 D7', () => {
    const points = appendAfterRetest({
      ...base,
      today: '2020-01-02',
      retestInterval: 'D1',
      result: 'YELLOW',
    });
    expect(codesOf(points), '黄灯只追加最近 2 档').toEqual(['D3', 'D7']);
  });

  it('D3 复测仍黄灯 → 追加 D7 与 D14', () => {
    const points = appendAfterRetest({
      ...base,
      today: '2020-01-04',
      retestInterval: 'D3',
      result: 'YELLOW',
    });
    expect(codesOf(points), '黄灯：D3 之后最近 2 档').toEqual(['D7', 'D14']);
  });

  it('D7 复测仍红灯 → 追加 D14/D21/D30，日期按 d0 计算', () => {
    const points = appendAfterRetest({
      ...base,
      today: '2020-01-08',
      retestInterval: 'D7',
      result: 'RED',
    });
    expect(codesOf(points), '红灯沿阶梯把后面全部补上').toEqual(['D14', 'D21', 'D30']);
    expect(
      points.map((point) => point.dueDate),
      'D14/D21/D30 = d0 + 14/21/30 天',
    ).toEqual(['2020-01-15', '2020-01-22', '2020-01-31']);
  });

  it('D30 复测仍失败 → 应继续按 30 天追加（长期失败单元不能被放弃）', () => {
    const points = appendAfterRetest({
      d0: '2020-01-01',
      today: '2020-01-31',
      retestInterval: 'D30',
      result: 'RED',
      existing: [],
    });
    expect(
      points.length,
      'D2（已修复）：阶梯不能止于 D30，appendAfterRetest 必须给出「每 30 天」的续期点',
    ).toBeGreaterThan(0);
  });

  it('D2：低频点仍 PENDING 时再次失败 → 不重复追加', () => {
    const points = appendAfterRetest({
      d0: '2020-01-01',
      today: '2020-02-20',
      retestInterval: 'LOW_FREQ_30',
      result: 'RED',
      existing: [{ intervalCode: 'LOW_FREQ_30', dueDate: '2020-03-01', status: 'PENDING' }],
    });
    expect(
      points,
      'D2：低频抽测点已在队列里，同档位不得重复追加（否则每提交一次复测就多出一条待办）',
    ).toEqual([]);
  });

  it('D2：低频点已 DONE 且再次失败 → 恰好追加 1 个 today+30（可无限续期）', () => {
    const points = appendAfterRetest({
      d0: '2020-01-01',
      today: '2020-02-20',
      retestInterval: 'LOW_FREQ_30',
      result: 'RED',
      existing: [{ intervalCode: 'LOW_FREQ_30', dueDate: '2020-02-15', status: 'DONE' }],
    });
    expect(codesOf(points), 'D2：恰好追加 1 个低频点，不能一次补齐多个').toEqual(['LOW_FREQ_30']);
    expect(
      points[0].dueDate,
      'D2：从 today 起算 +30 天（2020 为闰年，2/20 + 30 天 = 3/21）',
    ).toBe('2020-03-21');
    expect(points[0].estMinutes, 'D2：低频点预估 15 分钟').toBe(15);
  });

  it('复测绿灯 / 待判定 → 不追加', () => {
    expect(
      appendAfterRetest({ ...base, today: '2020-01-04', retestInterval: 'D3', result: 'GREEN' }),
      '绿灯交给 shouldMarkMastered，不追加结构化复习点',
    ).toEqual([]);
    expect(
      appendAfterRetest({ ...base, today: '2020-01-04', retestInterval: 'D3', result: 'PENDING' }),
      '无数据不排程',
    ).toEqual([]);
  });

  it('已存在同档位 PENDING → 不重复追加', () => {
    const points = appendAfterRetest({
      ...base,
      today: '2020-01-08',
      retestInterval: 'D7',
      result: 'RED',
      existing: [pending('D14', '2020-01-15')],
    });
    expect(codesOf(points), 'D14 已在队列里，只补 D21/D30').toEqual(['D21', 'D30']);
  });
});

describe('shouldMarkMastered —— 连续 2 次绿灯且间隔 ≥7 天', () => {
  it('间隔 7 天整 → 掌握（含边界）', () => {
    const result = shouldMarkMastered({
      reviews: [
        { reviewDate: '2020-01-01', color: 'GREEN' },
        { reviewDate: '2020-01-08', color: 'GREEN' },
      ],
    });
    expect(result.mastered, '间隔 7 天整必须判掌握（≥7）').toBe(true);
    expect(result.greenStreak, '连续绿灯次数应为 2').toBe(2);
    expect(result.anchorGapDays, '锚点间隔应为 7 天').toBe(7);
  });

  it('间隔 6 天 → 未掌握', () => {
    const result = shouldMarkMastered({
      reviews: [
        { reviewDate: '2020-01-01', color: 'GREEN' },
        { reviewDate: '2020-01-07', color: 'GREEN' },
      ],
    });
    expect(result.mastered, '间隔 6 天不足 7 天，不能判掌握').toBe(false);
    expect(result.anchorGapDays).toBe(6);
  });

  it('中间夹一次黄灯 → 连续链断裂，未掌握', () => {
    const result = shouldMarkMastered({
      reviews: [
        { reviewDate: '2020-01-01', color: 'GREEN' },
        { reviewDate: '2020-01-05', color: 'YELLOW' },
        { reviewDate: '2020-01-12', color: 'GREEN' },
      ],
    });
    expect(result.mastered, '黄灯打断了连续绿灯，不能判掌握').toBe(false);
    expect(result.greenStreak, '只有末尾 1 次连续绿灯').toBe(1);
  });

  it('三次绿灯但最后两次仅隔 1 天 → 未掌握（锚点只看最新两次）', () => {
    const result = shouldMarkMastered({
      reviews: [
        { reviewDate: '2020-01-01', color: 'GREEN' },
        { reviewDate: '2020-01-11', color: 'GREEN' },
        { reviewDate: '2020-01-12', color: 'GREEN' },
      ],
    });
    expect(result.mastered, '锚点间隔必须看最新两次（1 天），不能挑更早的 10 天').toBe(false);
    expect(result.greenStreak, 'streak 仍为 3').toBe(3);
  });

  it('入参乱序也能正确判定（内部按 reviewDate 排序）', () => {
    const result = shouldMarkMastered({
      reviews: [
        { reviewDate: '2020-01-08', color: 'GREEN' },
        { reviewDate: '2020-01-01', color: 'GREEN' },
      ],
    });
    expect(result.mastered, '排序后仍应判掌握').toBe(true);
    expect(result.anchorGapDays).toBe(7);
  });

  it('只有 1 次绿灯 → 未掌握', () => {
    const result = shouldMarkMastered({ reviews: [{ reviewDate: '2020-01-01', color: 'GREEN' }] });
    expect(result.mastered, '单次绿灯不足以判掌握').toBe(false);
    expect(result.greenStreak).toBe(1);
  });

  it('空复测记录 → 未掌握且不抛异常', () => {
    const result = shouldMarkMastered({ reviews: [] });
    expect(result.mastered, '无记录不能判掌握').toBe(false);
    expect(result.greenStreak).toBe(0);
  });
});

describe('nextLowFreqDate —— 掌握后转 30 天低频池', () => {
  it('掌握后 +30 天', () => {
    expect(nextLowFreqDate('2020-01-08'), '锚点 +30 天').toBe('2020-02-07');
  });

  it('跨月与闰年也要正确', () => {
    expect(nextLowFreqDate('2025-01-31'), '1 月 31 日 +30 天 = 3 月 2 日').toBe('2025-03-02');
    expect(nextLowFreqDate('2024-02-29'), '闰日 +30 天 = 3 月 30 日').toBe('2024-03-30');
    expect(nextLowFreqDate('2024-12-20'), '跨年 +30 天 = 次年 1 月 19 日').toBe('2025-01-19');
  });
});

describe('辅助口径', () => {
  it('overdueDays：正数表示逾期，负数表示未到期', () => {
    expect(overdueDays('2020-01-05', '2020-01-08'), '逾期 3 天').toBe(3);
    expect(overdueDays('2020-01-08', '2020-01-08'), '当日到期应为 0').toBe(0);
    expect(overdueDays('2020-01-12', '2020-01-08'), '未到期为负数').toBe(-4);
  });

  it('colorDistribution 四色齐全（含 0 计数）', () => {
    expect(colorDistribution([{ color: 'GREEN' }, { color: 'RED' }, { color: 'RED' }])).toEqual({
      PENDING: 0,
      GREEN: 1,
      YELLOW: 0,
      RED: 2,
    });
  });
});
