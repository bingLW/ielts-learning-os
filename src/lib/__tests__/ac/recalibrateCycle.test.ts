/**
 * T12 AC-13 主证据 —— `recalibrateCycleAction` 只产生新的周期版本，不改历史。
 *
 * 断言：
 * - 已有 CYCLE 版本行逐字段不变（append-only）；
 * - 校准不改写任何 PlanTask（当日无任务也不凭空生成）；
 * - 新版本 `layer='CYCLE'`、`changeSource='GENERATE'`、承载 8 项结构；
 * - 同一份证据重复校准 → `CONFLICT`（不产生第二版）。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb();

const { recalibrateCycleAction } = await import('@/lib/actions/planner');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-cycle';
const OLD_CYCLE_VERSION_ID = 'pv-old-cycle';

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S2_A2_B1',
      nameZh: '周期测试阶段',
      estDaysMin: 90,
      status: 'ACTIVE',
    },
  });
  await prisma.plannerSettings.create({
    data: { id: 1, defaultDailyMinutes: 60, minTaskMinutes: 5, isUserConfirmed: true },
  });
  await prisma.dailyBudget.create({
    data: { date: AS_OF, plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.learningGoal.create({
    data: { goalType: 'IELTS', name: 'IELTS 6.0', status: 'ACTIVE', targetValue: '总分 6.0' },
  });
  await prisma.learningCycle.create({
    data: {
      id: 'cycle-1',
      title: '第一个 90 天',
      goal: 'B1 稳定',
      startDate: '2026-09-01',
      endDate: '2026-11-30',
      status: 'BUILD',
      primaryTheme: '听力细节题',
    },
  });
  await prisma.planVersion.create({
    data: {
      id: OLD_CYCLE_VERSION_ID,
      planDate: '2026-09-01',
      version: 1,
      changeSource: 'GENERATE',
      reason: '首次周期计划',
      budgetMinutes: 0,
      actualMinutesAtChange: 0,
      beforeSnapshot: JSON.stringify({ cycleId: 'cycle-1' }),
      afterSnapshot: JSON.stringify({ stageGoal: '旧结构' }),
      snapshotId: 'old-snapshot',
      layer: 'CYCLE',
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('T12 AC-13 周期重新校准', () => {
  it('只新增 CYCLE 版本，旧版本与任务历史不变', async () => {
    const before = await prisma.planVersion.findUnique({ where: { id: OLD_CYCLE_VERSION_ID } });

    const result = await recalibrateCycleAction({
      asOfDate: AS_OF,
      cycleVersionId: OLD_CYCLE_VERSION_ID,
      reason: '证据变化，调整周期主题',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cycleId).toBe('cycle-1');
    expect(await prisma.planTask.count()).toBe(0);

    const created = await prisma.planVersion.findUnique({ where: { id: result.data.versionId } });
    expect(created).not.toBeNull();
    expect(created!.layer).toBe('CYCLE');
    expect(created!.changeSource).toBe('GENERATE');
    expect(created!.reason).toContain('周期重新校准');
    expect(created!.staleAt).toBeNull();
    const structure = JSON.parse(created!.afterSnapshot ?? 'null') as Record<string, unknown>;
    expect(Object.keys(structure)).toContain('stageGoal');
    expect(Object.keys(structure)).toContain('adjustmentConditions');
    const beforeSnapshot = JSON.parse(created!.beforeSnapshot ?? 'null') as Record<string, unknown>;
    expect(beforeSnapshot.cycleId).toBe('cycle-1');
    expect(beforeSnapshot.previousVersionId).toBe(OLD_CYCLE_VERSION_ID);

    const after = await prisma.planVersion.findUnique({ where: { id: OLD_CYCLE_VERSION_ID } });
    expect(after).toEqual(before);
  });

  it('同一份证据重复校准 → CONFLICT，不产生第二版', async () => {
    const countBefore = await prisma.planVersion.count({ where: { layer: 'CYCLE' } });
    const result = await recalibrateCycleAction({
      asOfDate: AS_OF,
      reason: '同一份证据重复点击重新校准',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFLICT');
    expect(await prisma.planVersion.count({ where: { layer: 'CYCLE' } })).toBe(countBefore);
  });

  it('非 CYCLE 版本不能作为校准基线 → VALIDATION', async () => {
    const dayVersion = await prisma.planVersion.create({
      data: {
        id: 'pv-day-1',
        planDate: AS_OF,
        version: 9,
        changeSource: 'GENERATE',
        budgetMinutes: 60,
        actualMinutesAtChange: 0,
        layer: null,
      },
    });
    const result = await recalibrateCycleAction({
      asOfDate: AS_OF,
      cycleVersionId: dayVersion.id,
      reason: '用日计划版本作为校准基线'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VALIDATION');
  });
});