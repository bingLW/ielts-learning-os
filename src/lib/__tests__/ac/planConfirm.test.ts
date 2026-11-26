/**
 * T07 AC-9 主证据 —— 验收 ⑥–⑧。
 *
 * - ⑥ 未确认草稿零 `PlanTask`（预览不落库的 action 侧证明）
 * - ⑦ 确认后 `changeSource ∈ {GENERATE, MANUAL_ADJUST}`
 * - ⑧ `PlanVersion.beforeSnapshot/afterSnapshot` 均可 JSON 解析
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb();

const { generatePlanPreviewAction, confirmPlanVersionAction } = await import('@/lib/actions/planner');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-confirm';
const INPUT = { purpose: 'GENERATE' as const, asOfDate: AS_OF, horizonDays: 1, stageId: STAGE_ID };

/** ⑧ 用独立基准日，避免与 ⑦ 的同输入快照复用成同一个 previewToken（会撞幂等键）。 */
const INPUT_ALT = { purpose: 'GENERATE' as const, asOfDate: '2026-11-26', horizonDays: 1, stageId: STAGE_ID };
const INPUT_OVERRIDE = { purpose: 'GENERATE' as const, asOfDate: '2026-11-27', horizonDays: 1, stageId: STAGE_ID };

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: '确认测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'B1_B2',
    },
  });
  await prisma.plannerSettings.create({
    data: { id: 1, defaultDailyMinutes: 60, minTaskMinutes: 5, isUserConfirmed: true },
  });
  await prisma.dailyBudget.create({
    data: { date: AS_OF, plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.dailyBudget.create({
    data: { date: '2026-11-26', plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.dailyBudget.create({
    data: { date: '2026-11-27', plannedAvailableMinutes: 90, isRestDay: false, source: 'USER' },
  });
  await prisma.learningGoal.create({
    data: { goalType: 'GENERAL_ENGLISH', name: '通用英语', status: 'ACTIVE', targetValue: 'B2' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('T07 确认/版本 action（AC-9）', () => {
  it('⑥ 未确认草稿零 PlanTask', async () => {
    const preview = await generatePlanPreviewAction(INPUT);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    // 预览已产出草稿，但还没确认 → 零 PlanTask
    expect(await prisma.planTask.count()).toBe(0);
  });

  it('⑦ 确认后 changeSource ∈ {GENERATE, MANUAL_ADJUST}', async () => {
    const preview = await generatePlanPreviewAction(INPUT);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const confirm = await confirmPlanVersionAction({
      ...INPUT,
      snapshotId: preview.data.snapshotId,
      previewToken: preview.data.previewToken,
    });
    expect(confirm.ok).toBe(true);
    if (!confirm.ok) return;

    const versions = await prisma.planVersion.findMany();
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(['GENERATE', 'MANUAL_ADJUST']).toContain(version.changeSource);
    }
  });

  it('⑨ 预览预算 60、确认预算 90 返回 CONFLICT 且零写入', async () => {
    const preview = await generatePlanPreviewAction({ ...INPUT_OVERRIDE, budgetOverrideMinutes: 60 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const tasksBefore = await prisma.planTask.count();
    const versionsBefore = await prisma.planVersion.count();

    const confirm = await confirmPlanVersionAction({
      ...INPUT_OVERRIDE,
      budgetOverrideMinutes: 90,
      snapshotId: preview.data.snapshotId,
      previewToken: preview.data.previewToken,
    });
    expect(confirm.ok).toBe(false);
    if (confirm.ok) return;
    expect(confirm.code).toBe('CONFLICT');
    expect(await prisma.planTask.count()).toBe(tasksBefore);
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
  });

  it('⑧ PlanVersion.beforeSnapshot / afterSnapshot 均可 JSON 解析', async () => {
    const preview = await generatePlanPreviewAction(INPUT_ALT);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const confirm = await confirmPlanVersionAction({
      ...INPUT_ALT,
      snapshotId: preview.data.snapshotId,
      previewToken: preview.data.previewToken,
    });
    expect(confirm.ok).toBe(true);
    if (!confirm.ok) return;

    // 头版本（带 snapshotId）承载前后快照
    const header = await prisma.planVersion.findUnique({ where: { id: confirm.data.versionId } });
    expect(header).not.toBeNull();

    const before = JSON.parse(header!.beforeSnapshot ?? 'null');
    const after = JSON.parse(header!.afterSnapshot ?? 'null');
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(typeof before).toBe('object');
    expect(typeof after).toBe('object');
  });
});
