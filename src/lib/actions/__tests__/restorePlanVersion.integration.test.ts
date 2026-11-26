/**
 * T13 ⑬（AC-15）行为证据：恢复 = **新建**版本，旧版仍在（append-only）。
 *
 * 为什么不写成渲染断言：渲染测试只能证明按钮在页面上；「version 递增、旧行不改」
 * 发生在 Prisma 事务边界里，只有真库能证明。本文件与 `history.render.test.tsx`
 * 同属 AC-15。
 */

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb();
const { restorePlanVersionAction } = await import('../planner');

afterAll(() => cleanup());

async function seedVersion(overrides: Record<string, unknown> = {}) {
  await prisma.planVersion.create({
    data: {
      id: 'ver-src-1',
      planDate: '2026-11-20',
      version: 1,
      changeSource: 'GENERATE',
      reason: '原始生成',
      budgetMinutes: 60,
      actualMinutesAtChange: 12,
      beforeSnapshot: '{"taskCount":0}',
      afterSnapshot: '{"taskCount":2}',
      snapshotId: 'snap-src',
      layer: null,
      ...overrides,
    },
  });
}

describe('T13 ⑬ restorePlanVersionAction：恢复生成新版本，不改历史行', () => {
  it('DAY 版本恢复 → version 递增，旧版逐字段不变', async () => {
    await prisma.planVersion.deleteMany({});
    await seedVersion();

    const result = await restorePlanVersionAction({ versionId: 'ver-src-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.version).toBe(2);

    const rows = await prisma.planVersion.findMany({ orderBy: { version: 'asc' } });
    expect(rows.map((row) => row.version)).toEqual([1, 2]);

    const [oldRow, newRow] = rows;
    // 旧行原样：append-only 的硬证据
    expect(oldRow.id).toBe('ver-src-1');
    expect(oldRow.reason).toBe('原始生成');
    expect(oldRow.actualMinutesAtChange).toBe(12);
    expect(oldRow.afterSnapshot).toBe('{"taskCount":2}');

    // 新行由旧行的 afterSnapshot 派生，来源为 REPLAN
    expect(newRow.reason).toBe('从版本 1 恢复');
    expect(newRow.changeSource).toBe('REPLAN');
    expect(newRow.beforeSnapshot).toBe(oldRow.afterSnapshot);
    expect(newRow.afterSnapshot).toBe(oldRow.afterSnapshot);
    expect(newRow.snapshotId).toBe('snap-src');
  });

  it('MONTH 版本 → PRECONDITION，零写入', async () => {
    await prisma.planVersion.deleteMany({});
    await seedVersion({ id: 'ver-month-1', layer: 'MONTH', version: 1 });

    const result = await restorePlanVersionAction({ versionId: 'ver-month-1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    await expect(prisma.planVersion.count()).resolves.toBe(1);
  });
});