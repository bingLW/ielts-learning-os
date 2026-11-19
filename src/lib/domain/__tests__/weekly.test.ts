/**
 * 被测文件：src/lib/domain/weekly.ts（+ completion.ts 的周完成率口径）
 * 规则来源：PRD §6.6 与「周复盘 13 项指标」（WEEKLY_METRIC_KEYS 为唯一清单）；
 *           PRD 硬要求 Top3 必须填满 3 项；无数据一律显示 —，绝不补 0。
 */

import { describe, expect, it } from 'vitest';
import {
  buildWeeklyMetrics,
  emptyTop3,
  isPartialWeek,
  mergeWeeklyMetrics,
  normalizeTop3,
  pickTop3FromRanked,
  skillBucketLabels,
  toStoredMetrics,
  validateTop3,
} from '../weekly';
// 周完成率的口径实现在 completion.ts（与日完成率同一实现），不在 weekly.ts。
import { weeklyCompletionRate } from '../completion';
import type { WeeklyMetricDraft, WeeklyRawInput } from '../weekly';
import {
  SKILL_BUCKET_ORDER,
  WEEKLY_METRIC_KEYS,
  WEEKLY_TOP3_COUNT,
} from '../../constants';
import { EMPTY_PLACEHOLDER } from '../../format';
import type { CompletionItem, WeaknessDto } from '../../types';

/** 一份「数据齐全」的周输入：所有分项都有值，便于逐项断言文案。 */
function makeInput(over: Partial<WeeklyRawInput> = {}): WeeklyRawInput {
  return {
    weekStart: '2025-03-03',
    weekEnd: '2025-03-09',
    netMinutes: 900,
    prevNetMinutes: 700,
    dailyMinutes: [
      { date: '2025-03-03', minutes: 135 },
      { date: '2025-03-05', minutes: 60 },
    ],
    completionByTime: 0.8333,
    skillMinutes: {
      LISTENING: 45,
      READING: 40,
      SPEAKING: 30,
      WRITING: 20,
      EXTENSIVE: 15,
      VOCAB: 25,
      GRAMMAR: 40,
      SENTENCE: 15,
      // META（复盘/元学习）是第 9 个分桶，必须显式给出；本 fixture 不涉及该桶，
      // 给 0 不会影响任何断言，但能让 Record<SkillBucket, number> 类型成立。
      META: 0,
      // v2.0 新增第 10 桶：英语媒介学习（跨技能应用）。同样不进四技能分母。
      MEDIATED: 0,
    },
    egiu: { green: 6, yellow: 3, red: 1, pending: 2 },
    prevEgiu: { green: 4, yellow: 3, red: 2, pending: 2 },
    review: { done: 5, failed: 1, overdue: 2, masteredLessons: 3 },
    mistakes: { added: 7, mastered: 2, topCategoryLabel: '记忆混淆' },
    vocab: { newCount: 18, reviewCount: 40, quizAccuracy: 0.82 },
    mastery: { RECOGNIZE_ONLY: 10, COMPREHEND: 20, ACTIVE_USE: 5 },
    dataDays: 6,
    daysElapsed: 6,
    ...over,
  };
}

/** 取某项指标的自动值。 */
function autoOf(drafts: WeeklyMetricDraft[], key: string): string {
  const found = drafts.find((draft) => draft.key === key);
  if (!found) throw new Error(`指标 ${key} 缺失：指标清单与 computeMetric 的 switch 不一致`);
  return found.autoValue;
}

describe('buildWeeklyMetrics —— 13 项必须按常量清单齐全', () => {
  it('指标清单常量恰好 13 项', () => {
    expect(WEEKLY_METRIC_KEYS.length, 'PRD 要求周复盘固定 13 项').toBe(13);
  });

  it('产出的 key 与 WEEKLY_METRIC_KEYS 完全一致（含顺序）', () => {
    const drafts = buildWeeklyMetrics(makeInput());
    expect(
      drafts.map((draft) => draft.key),
      '顺序即 UI 顺序：任何新增/调整都必须只改常量',
    ).toEqual([...WEEKLY_METRIC_KEYS]);
    expect(drafts.length, '13 项一项都不能少').toBe(13);
  });

  it('无数据指标用 — 占位，不用 0 冒充', () => {
    const drafts = buildWeeklyMetrics(makeInput({ dataDays: 0, completionByTime: null }));
    expect(autoOf(drafts, 'NET_MINUTES'), '本周无数据 → —').toBe(EMPTY_PLACEHOLDER);
    expect(autoOf(drafts, 'DAILY_DISTRIBUTION'), '本周无数据 → —').toBe(EMPTY_PLACEHOLDER);
    expect(autoOf(drafts, 'WEEK_OVER_WEEK'), '本周无数据 → —').toBe(EMPTY_PLACEHOLDER);
    expect(autoOf(drafts, 'COMPLETION_RATE'), '无完成率 → —').toBe(EMPTY_PLACEHOLDER);
    expect(autoOf(drafts, 'NET_MINUTES'), '绝不能用 0 冒充缺失').not.toBe('0 分');
  });

  it('NET_MINUTES = 总时长 + 日均（按有数据天数算）', () => {
    const drafts = buildWeeklyMetrics(makeInput());
    expect(autoOf(drafts, 'NET_MINUTES'), '900/6 = 150 分钟日均').toBe(
      '15 小时（日均 2 小时 30 分）',
    );
  });

  it('DAILY_DISTRIBUTION 补齐 7 天，缺日显示 0 分', () => {
    const drafts = buildWeeklyMetrics(makeInput());
    const text = autoOf(drafts, 'DAILY_DISTRIBUTION');
    const parts = text.split(' / ');
    expect(parts.length, '必须是 7 天').toBe(7);
    expect(parts[0], '周一 135 分钟').toBe('03-03 2 小时 15 分');
    expect(parts[1], '周二无数据补 0 分').toBe('03-04 0 分');
    expect(parts[2], '周三 60 分钟').toBe('03-05 1 小时');
  });

  it('COMPLETION_RATE 按百分比四舍五入', () => {
    const drafts = buildWeeklyMetrics(makeInput());
    expect(autoOf(drafts, 'COMPLETION_RATE'), '0.8333 → 83%').toBe('83%');
  });

  it('四科与语法/句子分桶文案', () => {
    const drafts = buildWeeklyMetrics(makeInput());
    expect(autoOf(drafts, 'LISTENING')).toBe('45 分');
    expect(autoOf(drafts, 'READING')).toBe('40 分');
    expect(autoOf(drafts, 'SPEAKING')).toBe('30 分');
    expect(autoOf(drafts, 'WRITING')).toBe('20 分');
    expect(autoOf(drafts, 'GRAMMAR'), '本周新掌握单元数附在语法项').toBe(
      '40 分（本周新掌握 3 个单元）',
    );
  });

  it('GRAMMAR 在没有新掌握单元时不追加说明', () => {
    const drafts = buildWeeklyMetrics(
      makeInput({ review: { done: 0, failed: 0, overdue: 0, masteredLessons: 0 } }),
    );
    expect(autoOf(drafts, 'GRAMMAR')).toBe('40 分');
  });

  it('COLOR_DELTA 三色环比带符号', () => {
    const drafts = buildWeeklyMetrics(makeInput());
    expect(autoOf(drafts, 'COLOR_DELTA')).toBe('绿 6(+2) / 黄 3(0) / 红 1(-1) / 待判定 2(0)');
  });

  it('三色全为 0 → —（没有单元就没有环比）', () => {
    const empty = { green: 0, yellow: 0, red: 0, pending: 0 };
    const drafts = buildWeeklyMetrics(makeInput({ egiu: empty, prevEgiu: empty }));
    expect(autoOf(drafts, 'COLOR_DELTA')).toBe(EMPTY_PLACEHOLDER);
  });

  it('MISTAKES 只在有逾期时追加逾期句', () => {
    const withOverdue = buildWeeklyMetrics(makeInput());
    expect(autoOf(withOverdue, 'MISTAKES')).toBe(
      '新增 7 道 · 标记掌握 2 道 · 复测完成 5 条（未通过 1 条） · 逾期未做 2 条',
    );

    const withoutOverdue = buildWeeklyMetrics(
      makeInput({ review: { done: 5, failed: 1, overdue: 0, masteredLessons: 0 } }),
    );
    expect(autoOf(withoutOverdue, 'MISTAKES').includes('逾期'), '无逾期不应出现逾期文案').toBe(
      false,
    );
  });

  it('VOCAB 三档分别计数，绝不合并', () => {
    const drafts = buildWeeklyMetrics(makeInput());
    expect(autoOf(drafts, 'VOCAB')).toBe(
      '新词 18 个 · 复习 40 个 · 抽测加权正确率 82% · 三档：认识 10 / 理解 20 / 主动用 5',
    );
  });

  it('VOCAB 无抽测数据 → —', () => {
    const drafts = buildWeeklyMetrics(
      makeInput({ vocab: { newCount: 18, reviewCount: 40, quizAccuracy: null } }),
    );
    expect(autoOf(drafts, 'VOCAB').includes(EMPTY_PLACEHOLDER), '抽测无数据显示 —').toBe(true);
  });

  it('TOP_ERROR_CATEGORY 无错题时给中文说明', () => {
    const drafts = buildWeeklyMetrics(
      makeInput({ mistakes: { added: 0, mastered: 0, topCategoryLabel: null } }),
    );
    expect(autoOf(drafts, 'TOP_ERROR_CATEGORY')).toBe('本期无错题记录');
  });

  it('WEEK_OVER_WEEK 给本周、上周与差额', () => {
    const drafts = buildWeeklyMetrics(makeInput());
    expect(autoOf(drafts, 'WEEK_OVER_WEEK')).toBe('15 小时（上周 11 小时 40 分，+200 分）');
  });
});

describe('周完成率口径（调用 completion 的同一实现）', () => {
  const week: CompletionItem[] = [
    { plannedMinutes: 200, actualMinutes: 200, status: 'DONE' },
    { plannedMinutes: 50, actualMinutes: 50, status: 'DONE' },
    { plannedMinutes: 100, actualMinutes: 0, status: 'MISSED' },
    { plannedMinutes: 50, actualMinutes: 0, status: 'MISSED' },
    { plannedMinutes: 50, actualMinutes: 0, status: 'MISSED' },
  ];

  it('两天 100% + 三天 0% → 250/450 ≈ 0.5556，而不是 40%', () => {
    const rate = weeklyCompletionRate(week);
    expect(rate.byTime as number, '先合分子分母：250/450').toBeCloseTo(250 / 450, 5);
    expect(rate.byTime as number, '不是五天完成率的算术平均 0.4').not.toBeCloseTo(0.4, 3);
  });
});

describe('mergeWeeklyMetrics / toStoredMetrics —— 自动值与手工覆盖', () => {
  const drafts = buildWeeklyMetrics(makeInput());

  it('13 项齐全且带中文标签', () => {
    const merged = mergeWeeklyMetrics(drafts, null);
    expect(merged.length, '必须与清单等长').toBe(13);
    expect(merged[0].label, '首项中文标签').toBe('净学习时长');
    expect(merged[0].overridden, '没有手工值 → 未覆盖').toBe(false);
    expect(merged[0].overrideValue).toBeNull();
    expect(merged[0].effectiveValue, '未覆盖时展示自动值').toBe(merged[0].autoValue);
  });

  it('手工覆盖值优先展示，并标记 overridden', () => {
    const merged = mergeWeeklyMetrics(drafts, {
      NET_MINUTES: { auto: '旧自动值', override: '  12 小时  ', overriddenAt: '2025-03-10T00:00:00Z' },
    });
    const netMinutes = merged.find((metric) => metric.key === 'NET_MINUTES');
    expect(netMinutes?.effectiveValue, '覆盖值需 trim 后展示').toBe('12 小时');
    expect(netMinutes?.overridden).toBe(true);
    expect(netMinutes?.autoValue, '自动值仍保留，便于回溯').toBe('15 小时（日均 2 小时 30 分）');
  });

  it('空白覆盖值视为未覆盖', () => {
    const merged = mergeWeeklyMetrics(drafts, {
      NET_MINUTES: { auto: 'x', override: '   ', overriddenAt: null },
    });
    const netMinutes = merged.find((metric) => metric.key === 'NET_MINUTES');
    expect(netMinutes?.overridden, '空白串不算覆盖').toBe(false);
    expect(netMinutes?.overrideValue).toBeNull();
  });

  it('落库只在有覆盖时写 overriddenAt', () => {
    const merged = mergeWeeklyMetrics(drafts, null);
    merged[1] = { ...merged[1], overrideValue: '手工值' };
    const stored = toStoredMetrics(merged, '2025-03-10T08:00:00.000Z');
    expect(stored.NET_MINUTES?.overriddenAt, '未覆盖 → null').toBeNull();
    expect(stored.DAILY_DISTRIBUTION?.overriddenAt, '有覆盖 → 写入时间戳').toBe(
      '2025-03-10T08:00:00.000Z',
    );
    expect(Object.keys(stored).length, '13 项全部落库').toBe(13);
  });
});

describe('不完整周判定', () => {
  it('周内未过完或有数据缺口都算不完整周', () => {
    expect(isPartialWeek(7, 7), '满 7 天且 7 天都有数据 → 完整周').toBe(false);
    expect(isPartialWeek(6, 7), '有数据缺口 → 不完整').toBe(true);
    expect(isPartialWeek(7, 6), '周内只过了 6 天 → 不完整').toBe(true);
    expect(isPartialWeek(0, 0), '天数为 0 时按 1 天算 → 不完整').toBe(true);
  });
});

describe('Top3 薄弱点', () => {
  const ranked: WeaknessDto[] = [
    { name: '听力定位', score: 0.7, evidence: '错 7/12 题', actionHint: 'a' },
    { name: '语法从句', score: 0.6, evidence: '错 5/10 题', actionHint: 'b' },
    { name: '写作任务回应', score: 0.5, evidence: '错 3/10 题', actionHint: 'c' },
    { name: '词汇', score: 0.4, evidence: '错 2/10 题', actionHint: 'd' },
  ];

  it('榜单只取前 3 项且标记为系统推荐', () => {
    const top3 = pickTop3FromRanked(ranked);
    expect(top3.length).toBe(WEEKLY_TOP3_COUNT);
    expect(top3.map((item) => item.name)).toEqual(['听力定位', '语法从句', '写作任务回应']);
    expect(top3.every((item) => item.manual === false), '自动推荐标记 manual=false').toBe(true);
  });

  it('emptyTop3 给出 3 个待填项', () => {
    const empty = emptyTop3();
    expect(empty.length).toBe(3);
    expect(empty.every((item) => item.manual && item.name === '')).toBe(true);
  });

  it('normalizeTop3 去空、夹分数、截断到 3 项', () => {
    const normalized = normalizeTop3([
      { name: '  听力  ', score: 1.8, evidence: ' e1 ', manual: false },
      { name: '   ', score: 0.5, evidence: 'x' },
      { name: '语法', score: -2, evidence: '' },
      { name: '写作', score: 0.5, evidence: 'e3' },
      { name: '第四项', score: 0.5, evidence: 'e4' },
    ]);
    expect(normalized.length, '最多 3 项').toBe(3);
    expect(normalized[0].name, '名称去空格').toBe('听力');
    expect(normalized[0].score, '分数上限 1').toBe(1);
    expect(normalized[1].name, '空名称被丢弃').toBe('语法');
    expect(normalized[1].score, '负分夹到 0').toBe(0);
  });

  it('validateTop3 不满 3 项必须拦住并给出可读文案', () => {
    const two = validateTop3([
      { name: '听力', score: 0.5, evidence: 'e', manual: true },
      { name: '语法', score: 0.5, evidence: 'e', manual: true },
    ]);
    expect(two.ok, 'PRD 硬要求：Top3 必须填满').toBe(false);
    if (!two.ok) expect(two.message.includes('3'), '文案必须说明需要 3 项').toBe(true);

    const three = validateTop3([
      { name: '听力', score: 0.5, evidence: 'e', manual: true },
      { name: '语法', score: 0.5, evidence: 'e', manual: true },
      { name: '写作', score: 0.5, evidence: 'e', manual: true },
    ]);
    expect(three.ok, '填满 3 项应通过').toBe(true);
  });
});

describe('分桶标签', () => {
  it('8 个桶的标签顺序与 SKILL_BUCKET_ORDER 一致', () => {
    const labels = skillBucketLabels();
    expect(labels.length, '必须 8 个桶').toBe(8);
    expect(labels.map((entry) => entry.bucket), '顺序即图表顺序').toEqual([...SKILL_BUCKET_ORDER]);
    expect(labels.every((entry) => entry.label.length > 0), '每个桶都要有中文标签').toBe(true);
  });
});
