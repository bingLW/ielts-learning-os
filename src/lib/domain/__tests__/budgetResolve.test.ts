/**
 * 有效预算解析的单一真值验证（v2.7 R-2 读侧翻版）。
 *
 * 这个文件存在的理由不是"覆盖率"，而是**防止两条实现再次分叉**：
 * `getEffectiveBudget`（逐日）与 `getBudgetRange`（批量）曾经是两份并行实现，
 * 在「没有 `PlannerSettings` 行」这条路径上给出不同答案（周日 0 分钟/休息日 vs
 * 建议 60 分钟/非休息日），而 H4 的分母、预算页的「这是建议值」标记都吃这个结果。
 *
 * 现在解析只有一处（`domain/budget.resolveEffectiveBudget`），两个查询函数是薄壳。
 * §2 的等价性用例是这条契约的**唯一**防线：以后谁在壳里加一个 `if`，它就会红。
 */

import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveEffectiveBudget, type BudgetResolveInput } from '../budget';
import { addDays } from '../../date';

const sourceDb = join(process.cwd(), 'prisma', 'dev.db');
const workDb = join(tmpdir(), `ielts-budget-${process.pid}-${Date.now()}.db`);

if (!existsSync(sourceDb)) throw new Error(`找不到数据库：${sourceDb}`);
copyFileSync(sourceDb, workDb);
process.env.DATABASE_URL = `file:${workDb}?connection_limit=1`;

const { prisma } = await import('@/lib/prisma');
const { getBudgetRange, getEffectiveBudget } = await import('@/lib/queries/budget');

/** 一个"没有 DailyBudget 行"的输入。 */
function input(over: Partial<BudgetResolveInput> = {}): BudgetResolveInput {
  return { date: '2025-10-20', daily: null, settings: null, ...over };
}

/** `2025-10-19` 是周日（用它验证"模板=0"与"无配置"的分界）。 */
const SUNDAY = '2025-10-19';
const MONDAY = '2025-10-20';

describe('resolveEffectiveBudget —— 五段分支（顺序即优先级）', () => {
  it('① 有 DailyBudget 行 → 原样透传（最高优先级，连 isSuggestion 都照搬）', () => {
    const result = resolveEffectiveBudget(
      input({
        daily: {
          id: 'db-1',
          plannedAvailableMinutes: 45,
          isRestDay: false,
          tierCode: 'LIGHT',
          budgetType: 'PRESET',
          source: 'USER',
          isInitialSuggestion: false,
        },
        settings: {
          isUserConfirmed: true,
          weekdayProfiles: '[120,120,120,120,120,120,120]',
          defaultDailyMinutes: 120,
        },
      }),
    );
    expect(result).toEqual({
      date: '2025-10-20',
      minutes: 45,
      isRestDay: false,
      tierCode: 'LIGHT',
      budgetType: 'PRESET',
      source: 'USER',
      isSuggestion: false,
      budgetId: 'db-1',
    });
  });

  it('① 显式设定为休息日时，0 分钟也照搬（不是"有行就一定有预算"）', () => {
    const result = resolveEffectiveBudget(
      input({
        daily: {
          id: 'db-2',
          plannedAvailableMinutes: 0,
          isRestDay: true,
          tierCode: 'REST',
          budgetType: 'REST_DAY',
          source: 'USER',
          isInitialSuggestion: false,
        },
        settings: { isUserConfirmed: true, weekdayProfiles: null, defaultDailyMinutes: 90 },
      }),
    );
    expect(result.minutes).toBe(0);
    expect(result.isRestDay).toBe(true);
    expect(result.budgetId).toBe('db-2');
    expect(result.isSuggestion).toBe(false);
  });

  it('② 配置存在但用户从未确认 → 只用 defaultDailyMinutes，且标记为建议', () => {
    const result = resolveEffectiveBudget(
      input({
        settings: {
          isUserConfirmed: false,
          weekdayProfiles: '[0,0,0,0,0,0,0]',
          defaultDailyMinutes: 75,
        },
      }),
    );
    expect(result).toEqual({
      date: '2025-10-20',
      minutes: 75,
      isRestDay: false,
      tierCode: null,
      budgetType: 'PRESET',
      source: 'DEFAULT_SUGGESTION',
      isSuggestion: true,
      budgetId: null,
    });
  });

  it('③ 模板该星期 > 0 → 按模板，且不是建议值', () => {
    // weekdayProfiles 下标 = 0(周日)..6(周六)；MONDAY 是 1
    const result = resolveEffectiveBudget(
      input({
        date: MONDAY,
        settings: {
          isUserConfirmed: true,
          weekdayProfiles: '[0,90,0,0,0,0,0]',
          defaultDailyMinutes: 60,
        },
      }),
    );
    expect(result.minutes).toBe(90);
    expect(result.source).toBe('WEEKDAY_TEMPLATE');
    expect(result.isRestDay).toBe(false);
    expect(result.isSuggestion).toBe(false);
  });

  it('④ 模板该星期 == 0 → 休息日（不是"回落到默认 60"）', () => {
    const result = resolveEffectiveBudget(
      input({
        date: SUNDAY,
        settings: {
          isUserConfirmed: true,
          weekdayProfiles: '[0,90,90,90,90,90,90]',
          defaultDailyMinutes: 60,
        },
      }),
    );
    expect(result).toEqual({
      date: SUNDAY,
      minutes: 0,
      isRestDay: true,
      tierCode: 'REST',
      budgetType: 'REST_DAY',
      source: 'WEEKDAY_TEMPLATE',
      isSuggestion: false,
      budgetId: null,
    });
  });

  it('⑤ 没有配置行（settings === null）→ 初始建议，且必须标记为建议', () => {
    const result = resolveEffectiveBudget(input({ settings: null }));
    expect(result.minutes).toBe(60);
    expect(result.isRestDay).toBe(false);
    expect(result.source).toBe('DEFAULT_SUGGESTION');
    expect(result.isSuggestion).toBe(true);
    expect(result.tierCode).toBeNull();
  });

  it('⑤ 没有配置行 + 周日 → 60 分钟 / 非休息日 / 建议值（本次行为修正的固化）', () => {
    // 旧 `getBudgetRange` 在这里按 [60,60,60,60,60,60,0] 的星期模板算，
    // 给出「0 分钟 / 休息日 / 非建议」，与 `getEffectiveBudget` 的「60 / 非休息 / 建议」
    // 直接矛盾。现在两者都必须给出后者。
    const result = resolveEffectiveBudget(input({ date: SUNDAY, settings: null }));
    expect(result.minutes).toBe(60);
    expect(result.isRestDay).toBe(false);
    expect(result.isSuggestion).toBe(true);
  });
});

describe('getBudgetRange 与 getEffectiveBudget 的逐字段等价性', () => {
  /** 30 天连续日期（跨 5 个周日），覆盖模板分支与窗口边界。 */
  const dates = Array.from({ length: 30 }, (_, index) => addDays('2025-10-01', index));

  beforeAll(async () => {
    // 清干净，保证本文件不依赖 dev.db 里的既有配置
    await prisma.dailyBudget.deleteMany({});
    await prisma.plannerSettings.deleteMany({});
  });

  afterAll(async () => {
    await prisma.dailyBudget.deleteMany({});
    await prisma.plannerSettings.deleteMany({});
    await prisma.$disconnect();
  });

  /** 三种配置状态 × 断言逐字段相等。 */
  async function assertEquivalent(label: string): Promise<void> {
    const range = await getBudgetRange(dates);
    const singles = await Promise.all(dates.map(async (date) => getEffectiveBudget(date)));
    for (let index = 0; index < dates.length; index += 1) {
      expect(range.get(dates[index]), `${label} · ${dates[index]} 批量 vs 逐日`).toEqual(
        singles[index],
      );
    }
  }

  it('配置不存在（settings === null）→ 逐日与批量逐字段相同', async () => {
    expect(await prisma.plannerSettings.findUnique({ where: { id: 1 } })).toBeNull();
    await assertEquivalent('无配置');
  });

  it('配置存在但未确认 → 逐日与批量逐字段相同', async () => {
    await prisma.plannerSettings.create({
      data: {
        id: 1,
        defaultDailyMinutes: 75,
        weekdayProfiles: '[90,45,0,30,60,75,120]',
        isUserConfirmed: false,
      },
    });
    await assertEquivalent('未确认');
  });

  it('配置已确认 + 部分日期有 DailyBudget 行 → 逐日与批量逐字段相同', async () => {
    await prisma.plannerSettings.update({
      where: { id: 1 },
      data: { isUserConfirmed: true },
    });
    // 每隔 7 天写一条显式预算（覆盖"最高优先级"分支），含一条休息日
    for (let index = 0; index < dates.length; index += 7) {
      await prisma.dailyBudget.create({
        data: {
          date: dates[index],
          plannedAvailableMinutes: index === 14 ? 0 : 45 + index,
          isRestDay: index === 14,
          tierCode: index === 14 ? 'REST' : 'LIGHT',
          budgetType: index === 14 ? 'REST_DAY' : 'PRESET',
          source: 'USER',
          isInitialSuggestion: false,
        },
      });
    }
    await assertEquivalent('已确认 + 显式日');

    // 顺带固化"显式行优先"：被写入的那一天必须等于行里的值，且不是建议
    const explicit = await getEffectiveBudget(dates[7]);
    expect(explicit.minutes).toBe(52);
    expect(explicit.isSuggestion).toBe(false);
    expect(explicit.budgetId).not.toBeNull();
  });

  it('周日行为一致：模板周日为 0 → 两边都是休息日（有显式行的那天除外）', async () => {
    // 把模板的周日（下标 0）显式设为 0，验证"模板=休息日"这条分支在两个壳里一致
    await prisma.plannerSettings.update({
      where: { id: 1 },
      data: { weekdayProfiles: '[0,45,30,30,60,75,120]' },
    });
    const range = await getBudgetRange(dates);
    const sundays = dates.filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0);
    expect(sundays.length, '30 天里必然跨几个周日').toBeGreaterThan(0);

    for (const date of sundays) {
      const single = await getEffectiveBudget(date);
      expect(range.get(date), `${date} 批量 vs 逐日`).toEqual(single);
      // 有显式 DailyBudget 行的那几天走最高优先级，不参与"模板=休息日"的断言
      if (single.budgetId === null) {
        expect(single.isRestDay, `${date} 模板周日为 0 → 休息日`).toBe(true);
        expect(single.minutes).toBe(0);
        expect(single.source).toBe('WEEKDAY_TEMPLATE');
      }
    }
  });
});
