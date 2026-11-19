/**
 * 被测文件：src/lib/domain/completion.ts
 * 规则来源：PRD §6.6（DONE=1；IN_PROGRESS/PARTIAL=clamp(actual/planned,0,1)；TODO/MISSED=0；
 *           按时长加权 Σ(权重×计划min)/Σ计划min；周完成率必须先合分子分母再相除；
 *           分母为 0 → null；顺延任务原日剔除、目标日计入）。
 *           + PRD Q5（有效产出五选一，output_text ≥20 字）。
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_OUTPUT_TEXT_LENGTH,
  completionRate,
  effectiveOutputCount,
  effectiveOutputRatio,
  investGap,
  isCountableForDate,
  isEffectiveOutput,
  isExecutedStatus,
  taskWeight,
  weeklyCompletionRate,
} from '../completion';
import type { CompletionItem } from '../../types';

function item(over: Partial<CompletionItem> = {}): CompletionItem {
  return { plannedMinutes: 45, actualMinutes: 45, status: 'DONE', ...over };
}

describe('taskWeight —— 单任务权重', () => {
  it('DONE=1，TODO/MISSED=0', () => {
    expect(taskWeight(item({ status: 'DONE', actualMinutes: 0 })), '已完成即使实际 0 分钟也记满').toBe(1);
    expect(taskWeight(item({ status: 'TODO' }))).toBe(0);
    expect(taskWeight(item({ status: 'MISSED' }))).toBe(0);
  });

  it('IN_PROGRESS / PARTIAL 按 actual/planned 折算', () => {
    expect(
      taskWeight(item({ status: 'IN_PROGRESS', plannedMinutes: 40, actualMinutes: 20 })),
      '20/40 = 0.5',
    ).toBe(0.5);
    expect(
      taskWeight(item({ status: 'PARTIAL', plannedMinutes: 40, actualMinutes: 10 })),
      '10/40 = 0.25',
    ).toBe(0.25);
  });

  it('实际超过计划时封顶 1（不放大完成率）', () => {
    expect(taskWeight(item({ status: 'PARTIAL', plannedMinutes: 10, actualMinutes: 999 }))).toBe(1);
  });

  it('实际为负数时夹到 0', () => {
    expect(taskWeight(item({ status: 'PARTIAL', plannedMinutes: 40, actualMinutes: -5 }))).toBe(0);
  });

  it('计划为 0 时按「有没有实际投入」退化为 0/1', () => {
    expect(
      taskWeight(item({ status: 'IN_PROGRESS', plannedMinutes: 0, actualMinutes: 30 })),
      '无法加权时，有实际投入记满',
    ).toBe(1);
    expect(
      taskWeight(item({ status: 'IN_PROGRESS', plannedMinutes: 0, actualMinutes: 0 })),
      '无计划无投入记 0',
    ).toBe(0);
  });
});

describe('completionRate —— 按时长加权', () => {
  it('时长权重正确（含 PARTIAL 折算）', () => {
    const rate = completionRate([
      item({ plannedMinutes: 45, actualMinutes: 45, status: 'DONE' }),
      item({ plannedMinutes: 40, actualMinutes: 20, status: 'PARTIAL' }),
      item({ plannedMinutes: 15, actualMinutes: 0, status: 'MISSED' }),
    ]);
    expect(rate.byTime as number, '(45 + 20 + 0) / (45+40+15) = 65/100').toBeCloseTo(0.65, 5);
    expect(rate.byCount as number, '任务数口径 1/3').toBeCloseTo(1 / 3, 5);
  });

  it('长任务比短任务影响更大（这正是「按时长加权」的意义）', () => {
    const rate = completionRate([
      item({ plannedMinutes: 200, actualMinutes: 0, status: 'MISSED' }),
      item({ plannedMinutes: 40, actualMinutes: 40, status: 'DONE' }),
    ]);
    expect(rate.byTime as number, '200/240 分钟没做 → 0.1667，而不是按任务数 0.5').toBeCloseTo(
      40 / 240,
      5,
    );
    expect(rate.byCount as number, '按任务数却是 0.5，说明两种口径不能混用').toBeCloseTo(0.5, 5);
  });

  it('空计划 → 两个口径都是 null（不是 0）', () => {
    const rate = completionRate([]);
    expect(rate.byTime, '分母为 0 必须返回 null').toBeNull();
    expect(rate.byCount, '没有任务时任务数口径也是 null').toBeNull();
  });

  it('有计划但全是 0 分钟任务 → byTime 为 null，byCount 仍可算', () => {
    const rate = completionRate([
      item({ plannedMinutes: 0, actualMinutes: 0, status: 'DONE' }),
      item({ plannedMinutes: 0, actualMinutes: 0, status: 'MISSED' }),
    ]);
    expect(rate.byTime, '计划总时长为 0 时不做时长口径').toBeNull();
    expect(rate.byCount as number, '任务数口径 = 1/2').toBeCloseTo(0.5, 5);
  });
});

describe('顺延任务 —— 原日剔除、目标日计入（换分母）', () => {
  const moved: CompletionItem = {
    plannedMinutes: 60,
    actualMinutes: 0,
    status: 'TODO',
    movedFromDate: '2025-03-01',
    movedToDate: '2025-03-02',
  };
  const stayed: CompletionItem = {
    plannedMinutes: 40,
    actualMinutes: 40,
    status: 'DONE',
    movedFromDate: null,
    movedToDate: null,
  };

  it('isCountableForDate：原日 false、目标日 true、未顺延 true', () => {
    expect(isCountableForDate(moved, '2025-03-01'), '原日不应再统计这条已顺延任务').toBe(false);
    expect(isCountableForDate(moved, '2025-03-02'), '目标日必须统计').toBe(true);
    expect(isCountableForDate(stayed, '2025-03-01'), '未顺延的任务始终计入').toBe(true);
  });

  it('按 isCountableForDate 过滤后，原日分母回到 40 分钟（100%）', () => {
    const viewItems = [moved, stayed].filter((task) => isCountableForDate(task, '2025-03-01'));
    const rate = completionRate(viewItems);
    expect(rate.byTime as number, '原日只剩 40 分钟任务且已完成 → 100%').toBeCloseTo(1, 5);
    expect(viewItems.length, '原日只剩 1 条任务').toBe(1);
  });

  it('目标日把顺延任务计入分母', () => {
    const targetItems = [moved].filter((task) => isCountableForDate(task, '2025-03-02'));
    const rate = completionRate(targetItems);
    expect(rate.byTime as number, '目标日只有这条 TODO 未做 → 0%').toBeCloseTo(0, 5);
    expect(rate.byCount, '已计入统计').not.toBeNull();
  });

  it('completionRate 自身不过滤 moved_out 行 —— 调用方必须先过滤', () => {
    const rate = completionRate([moved]);
    expect(
      rate.byTime as number,
      '直接传入带 movedFromDate 的行时，分母被虚增（见缺陷 D5：queries/plan.ts 把 movedFromDate 硬编码为 null）',
    ).toBeCloseTo(0, 5);
  });
});

describe('weeklyCompletionRate —— 先合分子分母，不取日均值平均', () => {
  it('两天 100%（大计划）+ 三天 0%（小计划）≠ 40%', () => {
    const week: CompletionItem[] = [
      item({ plannedMinutes: 200, actualMinutes: 200, status: 'DONE' }),
      item({ plannedMinutes: 50, actualMinutes: 50, status: 'DONE' }),
      item({ plannedMinutes: 100, actualMinutes: 0, status: 'MISSED' }),
      item({ plannedMinutes: 50, actualMinutes: 0, status: 'MISSED' }),
      item({ plannedMinutes: 50, actualMinutes: 0, status: 'MISSED' }),
    ];
    const rate = weeklyCompletionRate(week);
    const dailyMean = (1 + 1 + 0 + 0 + 0) / 5;
    expect(rate.byTime as number, '(200+50)/(450) = 0.5556').toBeCloseTo(250 / 450, 5);
    expect(
      rate.byTime as number,
      'PRD §6.6：周完成率不等于「每天完成率的平均（0.4）」，必须先合并分子分母',
    ).not.toBeCloseTo(dailyMean, 3);
  });

  it('与 completionRate 完全等价（同一实现，不允许两套口径）', () => {
    const week: CompletionItem[] = [
      item({ plannedMinutes: 30, actualMinutes: 15, status: 'PARTIAL' }),
      item({ plannedMinutes: 30, actualMinutes: 0, status: 'TODO' }),
    ];
    expect(weeklyCompletionRate(week)).toEqual(completionRate(week));
  });
});

describe('investGap / 有效产出', () => {
  it('投入缺口夹在 0..1，计划为 0 取 0', () => {
    expect(investGap(100, 40), '(100-40)/100 = 0.6').toBeCloseTo(0.6, 5);
    expect(investGap(100, 120), '超额完成不产生负缺口').toBe(0);
    expect(investGap(0, 10), '计划 0 → 0，避免「谁没计划谁最薄弱」').toBe(0);
  });

  it('output_text 字数边界：19 字不算、20 字算（PRD Q5）', () => {
    expect(MIN_OUTPUT_TEXT_LENGTH, '最小有效产出的字数门槛').toBe(20);
    expect(isEffectiveOutput({ totalQuestions: 0, outputText: 'a'.repeat(19) }), '19 字不够').toBe(
      false,
    );
    expect(isEffectiveOutput({ totalQuestions: 0, outputText: 'a'.repeat(20) }), '20 字达标').toBe(
      true,
    );
  });

  it('纯空白文本不算有效产出（trim 后计数）', () => {
    expect(
      isEffectiveOutput({ totalQuestions: 0, outputText: `${' '.repeat(30)}` }),
      '空白不算产出',
    ).toBe(false);
  });

  it('五条信号任一满足即算有效产出', () => {
    expect(isEffectiveOutput({ totalQuestions: 1 }), '有正确率').toBe(true);
    expect(isEffectiveOutput({ totalQuestions: 0, recordingUrl: 'https://x/y.mp3' }), '有录音').toBe(
      true,
    );
    expect(isEffectiveOutput({ totalQuestions: 0, mistakeCount: 1 }), '有关联错题').toBe(true);
    expect(isEffectiveOutput({ totalQuestions: 0, summaryEn: 'ok' }), '有英文摘要').toBe(true);
    expect(isEffectiveOutput({ totalQuestions: 0 }), '全都没有').toBe(false);
  });

  it('有效产出率：无记录 → null（不是 0）', () => {
    expect(effectiveOutputRatio([]), '没有记录时不能显示 0%').toBeNull();
    expect(
      effectiveOutputRatio([{ totalQuestions: 5 }, { totalQuestions: 0 }]),
      '2 条中 1 条有效',
    ).toBeCloseTo(0.5, 5);
    expect(effectiveOutputCount([{ totalQuestions: 5 }, { totalQuestions: 0 }])).toBe(1);
  });

  it('已执行状态只含 DONE / PARTIAL', () => {
    expect(isExecutedStatus('DONE')).toBe(true);
    expect(isExecutedStatus('PARTIAL')).toBe(true);
    expect(isExecutedStatus('TODO')).toBe(false);
    expect(isExecutedStatus('IN_PROGRESS'), '进行中不算已执行').toBe(false);
    expect(isExecutedStatus('MISSED')).toBe(false);
  });
});
