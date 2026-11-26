import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BudgetPlannerBody } from '../budget/BudgetPlannerBody';
import type { BudgetWeekDto, WeeklyTargetSummaryDto } from '@/lib/queries/planner';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

vi.mock('@/lib/actions/budget', () => ({
  setBudgetAction: vi.fn(),
  setWeeklyTargetAction: vi.fn(),
}));

const WEEK: BudgetWeekDto = {
  weekStart: '2026-11-23',
  weekEnd: '2026-11-29',
  days: [
    '2026-11-23',
    '2026-11-24',
    '2026-11-25',
    '2026-11-26',
    '2026-11-27',
    '2026-11-28',
    '2026-11-29',
  ].map((date) => ({
    date,
    budgetMinutes: 60,
    isRestDay: false,
    source: 'DEFAULT_SUGGESTION',
    tierCode: 'T60',
    isInitialSuggestion: true,
    plannedMinutes: 0,
    netMinutes: 0,
    taskCount: 0,
    doneCount: 0,
  })),
  totals: { budgetMinutes: 420, plannedMinutes: 0, netMinutes: 0 },
  isFirstInstallSuggestion: true,
};

const TARGET: WeeklyTargetSummaryDto = {
  weekStart: '2026-11-23',
  weekEnd: '2026-11-29',
  targetMinutes: 300,
  status: 'ACTIVE',
  source: 'MANUAL',
  note: null,
  actualNetMinutes: 0,
  allocations: [],
  recent: [],
};

describe('T13 渲染：/planner/budget', () => {
  it('④ 首次安装 → 明说「60 分钟是建议值」', () => {
    const html = renderToStaticMarkup(
      <BudgetPlannerBody week={WEEK} target={TARGET} asOfDate="2026-11-25" />,
    );
    expect(html).toContain('data-testid="first-install-notice"');
    expect(html).toContain('60 分钟是建议值');
    expect(html).toContain('不是你真实可用的时间');
  });

  it('⑤ 周总量 < 每日分配之和 → 二选一警告，不静默取一方', () => {
    const html = renderToStaticMarkup(
      <BudgetPlannerBody week={WEEK} target={TARGET} asOfDate="2026-11-25" />,
    );
    // 每日分配 420 分 > 周目标 300 分
    expect(html).toContain('data-testid="target-conflict"');
    expect(html).toContain('两者不会自动取一方');
    expect(html).toContain('提高周目标');
    expect(html).toContain('按周总量压缩每日分配');
    expect(html).toContain('WeeklyTarget 不参与实际预算解析');
  });

  it('周总量 ≥ 每日分配之和 → 不出现冲突警告', () => {
    const html = renderToStaticMarkup(
      <BudgetPlannerBody
        week={WEEK}
        target={{ ...TARGET, targetMinutes: 500 }}
        asOfDate="2026-11-25"
      />,
    );
    expect(html).not.toContain('data-testid="target-conflict"');
  });

  it('⑥ 改预算 → 「不会自动重排」提示 + 重排入口', () => {
    const html = renderToStaticMarkup(
      <BudgetPlannerBody week={WEEK} target={TARGET} asOfDate="2026-11-25" />,
    );
    expect(html).toContain('data-testid="no-auto-replan"');
    expect(html).toContain('不会自动重排');
    expect(html).toContain('也不会按比例裁剪任务');
    expect(html).toContain('href="/planner/replan?date=');
  });
});