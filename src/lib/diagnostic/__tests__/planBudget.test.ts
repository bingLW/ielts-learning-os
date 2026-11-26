import { describe, expect, it } from 'vitest';
import { addDays } from '@/lib/date';
import {
  resolveEffectiveBudget,
  type EffectiveBudget,
} from '@/lib/domain/budget';
import type { BudgetSource } from '@/lib/types';
import {
  buildPlanDraft,
  type PlanBudgetInput,
  type PlanProfileInput,
} from '../plan';

const AS_OF_DATE = '2026-11-27';
const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 } as const;

const PROFILES: PlanProfileInput[] = [
  {
    skill: 'LISTENING',
    estimatedLevel: 'A2',
    levelRange: ['A1', 'A2'],
    confidence: 'MEDIUM',
    needsFollowUp: true,
    evidenceCount: 2,
  },
  {
    skill: 'READING',
    estimatedLevel: 'B1',
    levelRange: ['A2', 'B1'],
    confidence: 'MEDIUM',
    needsFollowUp: false,
    evidenceCount: 2,
  },
];

type ExplicitDay = {
  minutes: number;
  source?: BudgetSource;
  isRestDay?: boolean;
  isSuggestion?: boolean;
};

function explicitDays(dayAt: (offset: number) => ExplicitDay): EffectiveBudget[] {
  return Array.from({ length: 90 }, (_, offset) => {
    const date = addDays(AS_OF_DATE, offset);
    const day = dayAt(offset);
    return resolveEffectiveBudget({
      date,
      daily: {
        id: `budget-${offset}`,
        plannedAvailableMinutes: day.minutes,
        isRestDay: day.isRestDay ?? false,
        tierCode: day.isRestDay ? 'REST' : 'CUSTOM',
        budgetType: day.isRestDay ? 'REST_DAY' : 'CUSTOM',
        source: day.source ?? 'USER',
        isInitialSuggestion: day.isSuggestion ?? false,
      },
      settings: null,
    });
  });
}

function unconfiguredDays(): EffectiveBudget[] {
  return Array.from({ length: 90 }, (_, offset) => {
    const date = addDays(AS_OF_DATE, offset);
    return resolveEffectiveBudget({ date, daily: null, settings: null });
  });
}

function expectWindowConstraints(plan: ReturnType<typeof buildPlanDraft>): void {
  for (const phase of plan.phases) {
    const exact = plan.budget.exact[phase.window];
    const taskMinutes = phase.tasks.reduce((sum, task) => sum + task.minutes, 0);
    expect(taskMinutes, `${phase.window} 任务总量`).toBeLessThanOrEqual(exact.totalMinutes);
    expect(phase.budget.totalMinutes).toBe(exact.totalMinutes);
    expect(phase.budget.startDate).toBe(exact.startDate);
    expect(phase.budget.endDate).toBe(exact.endDate);
  }
}

describe('buildPlanDraft 消费已解析的逐日预算', () => {
  it('每日显式预算与休息日按连续 7/30/90 天汇总，并保留逐日审计数据', () => {
    const firstWeek = [45, 0, 30, 60, 90, 15, 75];
    const days = explicitDays((offset) => ({
      minutes: firstWeek[offset] ?? 40,
      isRestDay: offset === 1,
    }));

    const plan = buildPlanDraft(PROFILES, days, AS_OF_DATE);

    expect(plan.budget.weeklyMinutes).toBe(315);
    expect(plan.budget.dailyAverage).toBe(45);
    expect(plan.budget.source).toBe('USER');
    expect(plan.rationale.budget).toEqual(days);
    expect(plan.rationale.notes.join('')).toContain('每周预算 315 分钟');

    for (const [window, dayCount] of Object.entries(WINDOW_DAYS)) {
      const typedWindow = window as keyof typeof WINDOW_DAYS;
      const exact = plan.budget.exact[typedWindow];
      const expectedDays = days.slice(0, dayCount);
      const expectedTotal = expectedDays.reduce(
        (sum, day) => sum + (day.isRestDay ? 0 : day.minutes),
        0,
      );
      expect(exact.startDate).toBe(AS_OF_DATE);
      expect(exact.endDate).toBe(addDays(AS_OF_DATE, dayCount - 1));
      expect(exact.days).toBe(dayCount);
      expect(exact.daily).toHaveLength(dayCount);
      expect(exact.totalMinutes).toBe(expectedTotal);
      expect(exact.dailyAverage).toBe(expectedTotal / dayCount);
      expect(exact.source).toBe('USER');
    }

    expect(plan.budget.exact['7D'].daily[1]).toMatchObject({
      date: addDays(AS_OF_DATE, 1),
      minutes: 0,
      isRestDay: true,
      source: 'USER',
    });
    expectWindowConstraints(plan);
  });

  it('无配置时使用解析器给出的建议值，不自行假设每日分钟数', () => {
    const days = unconfiguredDays();
    const plan = buildPlanDraft(PROFILES, days, AS_OF_DATE);

    expect(days[0]).toMatchObject({
      minutes: 60,
      source: 'DEFAULT_SUGGESTION',
      isSuggestion: true,
    });
    expect(plan.budget.exact['7D']).toMatchObject({
      totalMinutes: 420,
      dailyAverage: 60,
      source: 'MIXED',
    });
    expect(plan.budget.exact['30D'].totalMinutes).toBe(1800);
    expect(plan.budget.exact['90D'].totalMinutes).toBe(5400);
    expect(plan.budget.weeklyMinutes).toBe(420);
    expect(plan.rationale.notes.join('')).toContain('建议');
    expectWindowConstraints(plan);
  });

  it('区间内 source 不同才标为 MIXED，窗口外变化不污染 7D 来源', () => {
    const days = explicitDays((offset) => ({
      minutes: 50,
      source: offset < 7 ? 'USER' : 'MIGRATION',
    }));
    const plan = buildPlanDraft(PROFILES, days, AS_OF_DATE);

    expect(plan.budget.exact['7D'].source).toBe('USER');
    expect(plan.budget.exact['30D'].source).toBe('MIXED');
    expect(plan.budget.exact['90D'].source).toBe('MIXED');
    expect(plan.budget.source).toBe('USER');
    expectWindowConstraints(plan);
  });

  it('0 预算时即使有补测画像或完全无画像，也不产生 20 分钟兜底任务', () => {
    const days = explicitDays(() => ({ minutes: 0 }));

    for (const profiles of [PROFILES, []]) {
      const plan = buildPlanDraft(profiles, days, AS_OF_DATE);
      expect(plan.budget.weeklyMinutes).toBe(0);
      expect(plan.budget.dailyAverage).toBe(0);
      for (const window of ['7D', '30D', '90D'] as const) {
        expect(plan.budget.exact[window]).toMatchObject({
          totalMinutes: 0,
          dailyAverage: 0,
          source: 'USER',
        });
        expect(plan.phases.find((phase) => phase.window === window)?.tasks).toEqual([]);
      }
      expectWindowConstraints(plan);
    }
  });

  it('7D 为 0 而后续窗口有预算时，各阶段只使用自己的窗口', () => {
    const days = explicitDays((offset) => ({
      minutes: offset < 7 ? 0 : 100,
      isRestDay: offset < 7,
    }));
    const plan = buildPlanDraft(PROFILES, days, AS_OF_DATE);

    expect(plan.budget.exact['7D'].totalMinutes).toBe(0);
    expect(plan.budget.exact['30D'].totalMinutes).toBe(2300);
    expect(plan.budget.exact['90D'].totalMinutes).toBe(8300);
    expect(plan.phases.find((phase) => phase.window === '7D')?.tasks).toEqual([]);
    expect(plan.phases.find((phase) => phase.window === '30D')?.tasks.length).toBeGreaterThan(0);
    expect(plan.phases.find((phase) => phase.window === '90D')?.tasks.length).toBeGreaterThan(0);
    expectWindowConstraints(plan);
  });

  it('30D 小额预算不借用 90D 预算', () => {
    const days = explicitDays((offset) => ({
      minutes: offset < 7 ? 10 : offset < 30 ? 0 : 5,
      isRestDay: offset >= 7 && offset < 30,
    }));
    const plan = buildPlanDraft(PROFILES, days, AS_OF_DATE);

    expect(plan.budget.exact['7D'].totalMinutes).toBe(70);
    expect(plan.budget.exact['30D'].totalMinutes).toBe(70);
    expect(plan.budget.exact['90D'].totalMinutes).toBe(370);
    expect(plan.phases.find((phase) => phase.window === '30D')?.tasks.length).toBeGreaterThan(0);
    expect(plan.phases.find((phase) => phase.window === '90D')?.tasks.length).toBeGreaterThan(0);
    expectWindowConstraints(plan);
  });

  it('不足 5 分钟的剩余预算不生成会被保存 schema 拒绝或抬高的任务', () => {
    const days = explicitDays(() => ({ minutes: 4 }));
    const plan = buildPlanDraft(PROFILES, days, AS_OF_DATE);

    expect(plan.budget.exact['7D'].totalMinutes).toBe(28);
    expectWindowConstraints(plan);
    expect(plan.phases.find((phase) => phase.window === '7D')?.tasks).toEqual([]);
    expect(plan.phases.every((phase) => phase.tasks.length === 0)).toBe(true);
    expect(plan.phases.every((phase) => phase.tasks.every((task) => task.minutes >= 5))).toBe(true);
  });

  it('缺少连续业务日时拒绝静默按 0 预算生成草案', () => {
    const days: PlanBudgetInput[] = unconfiguredDays().slice(0, 7);
    expect(() => buildPlanDraft(PROFILES, days, AS_OF_DATE)).toThrow(
      /缺少 2026-12-04 的已解析预算/,
    );
  });
});
