/**
 * 被测文件：src/lib/domain/suggestion.ts
 *
 * 验收判据（P5）：
 * 1. 每条建议必须带非空 basis（数据依据）；
 * 2. 不编造成绩 —— 无数据时返回空数组，不凭空生成；
 * 3. 建议是确定性的（同一输入 → 同一输出）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildPlanSuggestions,
  buildWeaknessSuggestions,
  buildWeeklySuggestions,
  PLAN_DEVIATION_MIN_PT,
} from '../suggestion';
import type { WeaknessDto } from '../../types';
import type { WeeklyRawInput } from '../weekly';

function weak(over: Partial<WeaknessDto>): WeaknessDto {
  return {
    name: '听力整体',
    score: 0.6,
    evidence: '错 12/30 题（最差来源） · 主要类别=时态',
    actionHint: '先清 2 条逾期复习，再追加 15 分钟专项练习',
    ...over,
  };
}

function weeklyInput(over: Partial<WeeklyRawInput> = {}): WeeklyRawInput {
  return {
    weekStart: '2026-11-09',
    weekEnd: '2026-11-15',
    netMinutes: 300,
    prevNetMinutes: 200,
    dailyMinutes: [],
    completionByTime: null,
    skillMinutes: {
      LISTENING: 0,
      READING: 0,
      SPEAKING: 0,
      WRITING: 0,
      EXTENSIVE: 0,
      VOCAB: 0,
      GRAMMAR: 0,
      SENTENCE: 0,
      META: 0,
      MEDIATED: 0,
    },
    egiu: { green: 0, yellow: 0, red: 0, pending: 0 },
    prevEgiu: { green: 0, yellow: 0, red: 0, pending: 0 },
    review: { done: 0, failed: 0, overdue: 0, masteredLessons: 0 },
    mistakes: { added: 0, mastered: 0, topCategoryLabel: null },
    vocab: { newCount: 0, reviewCount: 0, quizAccuracy: null },
    mastery: { RECOGNIZE_ONLY: 0, COMPREHEND: 0, ACTIVE_USE: 0 },
    dataDays: 0,
    daysElapsed: 7,
    ...over,
  };
}

describe('buildWeaknessSuggestions —— 每条建议带 basis', () => {
  it('从达标弱项生成建议，basis 引用 evidence', () => {
    const drafts = buildWeaknessSuggestions([weak({})], []);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].basis).toContain('错 12/30 题');
    expect(drafts[0].title).toContain('听力整体');
  });

  it('样本不足维度单独汇总，不假装知道谁弱', () => {
    const drafts = buildWeaknessSuggestions(
      [],
      [weak({ name: '写作整体' }), weak({ name: '口语整体' })],
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toContain('样本不足');
    expect(drafts[0].basis).toContain('写作整体');
    expect(drafts[0].basis).toContain('口语整体');
  });

  it('完全无数据时返回空数组，不编造', () => {
    expect(buildWeaknessSuggestions([], [])).toEqual([]);
  });
});

describe('buildWeeklySuggestions —— 规则逐条可复现、basis 非空', () => {
  it('完成率 <60% 生成建议，basis 引用真实百分比', () => {
    const drafts = buildWeeklySuggestions(weeklyInput({ completionByTime: 0.42 }));
    expect(drafts.some((d) => d.title.includes('完成率'))).toBe(true);
    const hit = drafts.find((d) => d.title.includes('完成率'))!;
    expect(hit.basis).toContain('42%');
  });

  it('词汇抽测 <80% 生成建议', () => {
    const drafts = buildWeeklySuggestions(weeklyInput({ vocab: { newCount: 0, reviewCount: 0, quizAccuracy: 0.72 } }));
    expect(drafts.some((d) => d.title.includes('词汇抽测'))).toBe(true);
  });

  it('逾期复习 >0 生成建议，basis 引用条数', () => {
    const drafts = buildWeeklySuggestions(weeklyInput({ review: { done: 0, failed: 0, overdue: 5, masteredLessons: 0 } }));
    const hit = drafts.find((d) => d.title.includes('逾期复习'))!;
    expect(hit.basis).toContain('5 条');
  });

  it('时长环比下滑超 30% 生成建议', () => {
    const drafts = buildWeeklySuggestions(
      weeklyInput({ netMinutes: 100, prevNetMinutes: 200, dataDays: 5 }),
    );
    expect(drafts.some((d) => d.title.includes('环比下滑'))).toBe(true);
  });

  it('无任何信号时返回空数组，不编造', () => {
    const drafts = buildWeeklySuggestions(weeklyInput({ dataDays: 3, completionByTime: 0.9 }));
    expect(drafts).toEqual([]);
  });
});

describe('buildPlanSuggestions —— 配比偏离才生成', () => {
  it('分母为 0（无四项训练数据）返回空数组', () => {
    const minutes = { LISTENING: 0, READING: 0, SPEAKING: 0, WRITING: 0, FOUNDATION: 0 };
    const target = { LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 15 };
    expect(buildPlanSuggestions(minutes, target)).toEqual([]);
  });

  it('口语欠配超阈值时生成「投入偏低」建议', () => {
    // 口语 0 分钟，其余三技能各 100 分钟 → 口语实际 0%，目标 25% → 欠 25pt
    const minutes = { LISTENING: 100, READING: 100, SPEAKING: 0, WRITING: 100, FOUNDATION: 0 };
    const target = { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 };
    const drafts = buildPlanSuggestions(minutes, target);
    const speaking = drafts.find((d) => d.title.includes('口语'));
    expect(speaking).toBeDefined();
    expect(speaking!.title).toContain('投入偏低');
    expect(speaking!.basis).toContain('0%');
  });

  it('配比接近时（偏离 <5pt）不生成建议', () => {
    const minutes = { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25, FOUNDATION: 0 };
    const target = { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 };
    expect(buildPlanSuggestions(minutes, target)).toEqual([]);
  });

  it('偏离阈值常量可被断言', () => {
    expect(PLAN_DEVIATION_MIN_PT).toBe(5);
  });
});
