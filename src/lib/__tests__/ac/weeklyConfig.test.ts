/**
 * T07 AC-4 主证据 —— 验收 ⑨–⑪：四技能配比可配置且真的影响计划。
 *
 * - ⑨ 切 `Stage.profileCode`（`A0_A2` 30/30/25/15 → `B1_B2` 25/25/25/25）后重新生成
 *   7 天计划 → 四技能分钟按新配比变化，且每个技能分钟都是粒度整数倍；
 * - ⑩ 改 `WeeklyTarget.targetMinutes` 总量 → 单日计划分钟仍以 `DailyBudget` 为准
 *   （断言：某日 `DailyBudget=30` 时该日计划 ≤ 30，即使周目标调高）；
 * - ⑪ 配比四项之和 ≠ 100 → `fail('VALIDATION')` 且不做任何配平（不是回落 25/25/25/25）。
 *
 * 三条写测试的自我约束（`41 §1.9`）：
 * - A-1：⑨ 断言用「两个配比下的四技能分钟向量」比较，不反查被测函数的拆分公式。
 * - A-2：期望值手抄字面量（预算 90 / 粒度 5 / 配比 30/30/25/15 与 25/25/25/25）。
 * - A-3：每条断言都能说出"哪种错误实现会让它红"：
 *   ⑨ 配比不生效 → 两向量相等红；⑩ `WeeklyTarget` 参与日预算 → 调高周目标后合计变，红；
 *   ⑪ 实现回落 25/25/25/25 → `fail('VALIDATION')` 变 `ok`，红。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import type { BuildPlanResult } from '@/lib/services/planBuild';

const { prisma, cleanup } = await createTestDb();

const { buildPlan } = await import('@/lib/services/planBuild');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-weekly';
const BROKEN_STAGE_ID = 'stage-broken';
const GRANULARITY = 5;

/** ⑨ 用的 7 个连续日期（预算 90/日）。 */
const NINE_DATES = [
  '2026-11-25',
  '2026-11-26',
  '2026-11-27',
  '2026-11-28',
  '2026-11-29',
  '2026-11-30',
  '2026-12-01',
];

/** ⑩ 用的 7 个连续日期（首日预算 30，其余 60）。 */
const TEN_DATES = [
  '2026-12-08',
  '2026-12-09',
  '2026-12-10',
  '2026-12-11',
  '2026-12-12',
  '2026-12-13',
  '2026-12-14',
];
const TEN_LOW_DATE = '2026-12-08';

const FOUR_SKILLS = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as const;
type FourSkill = (typeof FOUR_SKILLS)[number];

/** 把整份结果里 `primarySkill` 落在四技能上的 `plannedMinutes` 按技能累加。 */
function fourSkillMinutes(result: BuildPlanResult): Record<FourSkill, number> {
  const out: Record<FourSkill, number> = { LISTENING: 0, READING: 0, SPEAKING: 0, WRITING: 0 };
  for (const day of result.days) {
    for (const task of day.tasks) {
      if ((FOUR_SKILLS as readonly string[]).includes(task.primarySkill)) {
        out[task.primarySkill as FourSkill] += task.plannedMinutes;
      }
    }
  }
  return out;
}

/** 7 天全部任务分钟之和（⑩ 用来证明周目标不参与日预算）。 */
function totalPlanned(result: BuildPlanResult): number {
  return result.days.reduce(
    (sum, day) => sum + day.tasks.reduce((inner, task) => inner + task.plannedMinutes, 0),
    0,
  );
}

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: '周配比测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'A0_A2',
    },
  });
  await prisma.stage.create({
    data: {
      id: BROKEN_STAGE_ID,
      code: 'S2_A2_B1',
      nameZh: '损坏配比测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'BROKEN_SUM',
    },
  });
  await prisma.skillAllocationProfile.createMany({
    data: [
      {
        profileCode: 'A0_A2',
        listeningPct: 30,
        readingPct: 30,
        speakingPct: 25,
        writingPct: 15,
        effectiveFrom: '2026-01-01',
        isActive: true,
      },
      {
        profileCode: 'B1_B2',
        listeningPct: 25,
        readingPct: 25,
        speakingPct: 25,
        writingPct: 25,
        effectiveFrom: '2026-01-01',
        isActive: true,
      },
      {
        // 四项之和 = 110 ≠ 100（⑪ 故意造坏）
        profileCode: 'BROKEN_SUM',
        listeningPct: 30,
        readingPct: 30,
        speakingPct: 25,
        writingPct: 25,
        effectiveFrom: '2026-01-01',
        isActive: true,
      },
    ],
  });
  await prisma.plannerSettings.create({
    data: { id: 1, defaultDailyMinutes: 90, minTaskMinutes: GRANULARITY, isUserConfirmed: true },
  });
  await prisma.learningGoal.create({
    data: { goalType: 'GENERAL_ENGLISH', name: '通用英语', status: 'ACTIVE', targetValue: 'B2' },
  });
  // ⑨ 的 7 天日预算（90/日）：让候选池为空、四技能分钟完全由配比驱动
  for (const date of NINE_DATES) {
    await prisma.dailyBudget.create({
      data: { date, plannedAvailableMinutes: 90, isRestDay: false, source: 'USER' },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('T07 四技能配比可配置（AC-4）', () => {
  it('⑨ 切 profileCode（A0_A2 → B1_B2）后重新生成 7 天 → 四技能分钟按新配比变化且均为粒度整数倍', async () => {
    const first = await buildPlan({ purpose: 'GENERATE', asOfDate: AS_OF, horizonDays: 7, stageId: STAGE_ID });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const before = fourSkillMinutes(first.data);
    // 每个技能分钟都必须是粒度（5）的整数倍
    for (const skill of FOUR_SKILLS) {
      expect(before[skill] % GRANULARITY).toBe(0);
    }

    // 切到 B1_B2（25/25/25/25），重新生成
    await prisma.stage.update({ where: { id: STAGE_ID }, data: { profileCode: 'B1_B2' } });
    const second = await buildPlan({ purpose: 'GENERATE', asOfDate: AS_OF, horizonDays: 7, stageId: STAGE_ID });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const after = fourSkillMinutes(second.data);
    for (const skill of FOUR_SKILLS) {
      expect(after[skill] % GRANULARITY).toBe(0);
    }

    // 配比真的影响计划：LISTENING 30% → 25% 应变少，WRITING 15% → 25% 应变多
    expect(after.LISTENING).toBeLessThan(before.LISTENING);
    expect(after.WRITING).toBeGreaterThan(before.WRITING);
  });

  it('⑩ 调高 WeeklyTarget 总量 → 7 天合计不变，单日仍以 DailyBudget 为准（30 分钟日计划 ≤ 30）', async () => {
    // 首日预算 30，其余 60
    for (const date of TEN_DATES) {
      const isLow = date === TEN_LOW_DATE;
      await prisma.dailyBudget.create({
        data: { date, plannedAvailableMinutes: isLow ? 30 : 60, isRestDay: false, source: 'USER' },
      });
    }

    const input = { purpose: 'GENERATE' as const, asOfDate: TEN_DATES[0], horizonDays: 7, stageId: STAGE_ID };
    const first = await buildPlan(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const totalBefore = totalPlanned(first.data);
    const lowDayBefore = first.data.days.find((day) => day.date === TEN_LOW_DATE)!;
    const lowPlannedBefore = lowDayBefore.tasks.reduce((sum, task) => sum + task.plannedMinutes, 0);
    expect(lowPlannedBefore).toBeLessThanOrEqual(30);

    // 把周目标调高到 2000，并给每天 300 分钟的周分配 —— 若实现误读周目标，日预算会被顶上去
    const weeklyTarget = await prisma.weeklyTarget.create({
      data: { weekStart: '2026-12-07', targetMinutes: 2000, source: 'USER' },
    });
    for (const date of TEN_DATES) {
      await prisma.weeklyDayAllocation.create({
        data: { weeklyTargetId: weeklyTarget.id, date, availableMinutes: 300, isRestDay: false },
      });
    }

    const second = await buildPlan(input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const totalAfter = totalPlanned(second.data);
    const lowDayAfter = second.data.days.find((day) => day.date === TEN_LOW_DATE)!;
    const lowPlannedAfter = lowDayAfter.tasks.reduce((sum, task) => sum + task.plannedMinutes, 0);

    // 周目标调高不影响计划：7 天合计不变，30 分钟日仍 ≤ 30
    expect(totalAfter).toBe(totalBefore);
    expect(lowPlannedAfter).toBeLessThanOrEqual(30);
  });

  it('⑪ 配比四项之和 ≠ 100 → fail(VALIDATION)，不做任何配平', async () => {
    const result = await buildPlan({
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 1,
      stageId: BROKEN_STAGE_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VALIDATION');
  });
});
