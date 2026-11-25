/**
 * T08 AC-11 ⑩ —— `carryoverPolicy()` + `applyCarryover()` 落库集成。
 *
 * ⑩ 每次移动必写 `rescheduleReason` / `deferReason`（非空断言），
 *    并断言 PROMOTE / DEMOTE / BACKLOG / ABANDON 各自的 `PlanTask` 写回结果。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

const { prisma, path } = await createTestDb(['planTask']);

const { carryoverPolicy } = await import('@/lib/domain/carryover');
const { applyCarryover } = await import('@/lib/services/carryoverApply');

const STAGE_ID = 'stage-carryover';
const AS_OF = '2026-11-25';

async function createTask(seed: {
  id: string;
  module: string;
  skill: string;
  plannedMinutes: number;
  actualMinutes: number;
  status: string;
  priority: string;
  planDate: string;
  movedCount: number;
  splittable: boolean;
}) {
  await prisma.planTask.create({
    data: {
      id: seed.id,
      stageId: STAGE_ID,
      planDate: seed.planDate,
      module: seed.module,
      skill: seed.skill,
      plannedMinutes: seed.plannedMinutes,
      actualMinutes: seed.actualMinutes,
      status: seed.status,
      priority: seed.priority,
      sourceKind: 'CORE',
      splittable: seed.splittable,
      minChunkMinutes: 5,
      movedCount: seed.movedCount,
      sortOrder: 0,
      planVersion: 1,
      track: 'GENERAL_ENGLISH',
      primarySkill: seed.module,
      timerStatus: 'IDLE',
    },
  });
}

beforeAll(async () => {
  await prisma.stage.create({
    data: { id: STAGE_ID, code: 'CARRYOVER_TEST', nameZh: 'carryover 测试', estDaysMin: 30, status: 'ACTIVE' },
  });

  await createTask({ id: 't-promote', module: 'P0_REVIEW', skill: 'META', plannedMinutes: 10, actualMinutes: 0, status: 'MISSED', priority: 'P0', planDate: '2026-11-23', movedCount: 0, splittable: true });
  await createTask({ id: 't-demote', module: 'P0_REVIEW', skill: 'META', plannedMinutes: 10, actualMinutes: 0, status: 'MISSED', priority: 'P0', planDate: '2026-11-20', movedCount: 0, splittable: true });
  await createTask({ id: 't-backlog', module: 'WRITING', skill: 'WRITING', plannedMinutes: 30, actualMinutes: 0, status: 'MISSED', priority: 'P1', planDate: '2026-11-24', movedCount: 0, splittable: false });
  await createTask({ id: 't-abandon', module: 'EXTENSIVE', skill: 'LISTENING_EXT', plannedMinutes: 15, actualMinutes: 0, status: 'MISSED', priority: 'P3', planDate: '2026-11-24', movedCount: 0, splittable: true });
});

afterAll(async () => {
  await prisma.$disconnect();
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(path)) unlinkSync(path);
});

describe('T08 carryover 落库（AC-11 ⑩）', () => {
  it('⑩ 每次移动必写 rescheduleReason/deferReason 且状态正确', async () => {
    const overdue = await prisma.planTask.findMany({
      where: { id: { in: ['t-promote', 't-demote', 't-backlog', 't-abandon'] } },
      orderBy: { id: 'asc' },
    });

    const policy = carryoverPolicy({
      asOfDate: AS_OF,
      overdue: overdue.map((row) => ({
        taskId: row.id,
        module: row.module as Parameters<typeof carryoverPolicy>[0]['overdue'][number]['module'],
        priority: row.priority as Parameters<typeof carryoverPolicy>[0]['overdue'][number]['priority'],
        plannedMinutes: row.plannedMinutes,
        actualMinutes: row.actualMinutes,
        status: row.status as Parameters<typeof carryoverPolicy>[0]['overdue'][number]['status'],
        planDate: row.planDate,
        movedCount: row.movedCount,
        splittable: row.splittable,
        minChunkMinutes: row.minChunkMinutes,
        deferReason: row.deferReason,
      })),
      // 100×0.25=25 分钟上限：PROMOTE(10) + DEMOTE(10) 都放得下，不被挤回 BACKLOG
      budgetMinutes: 100,
    });

    const applied = await applyCarryover({ targetDate: AS_OF, decisions: policy.decisions });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // PROMOTE：滚入今日，P0 保留，写非空 rescheduleReason，movedCount +1
    const promote = await prisma.planTask.findUnique({ where: { id: 't-promote' } });
    expect(promote?.planDate).toBe(AS_OF);
    expect(promote?.movedToDate).toBe(AS_OF);
    expect(promote?.priority).toBe('P0');
    expect(promote?.status).toBe('TODO');
    expect(promote?.movedCount).toBe(1);
    expect(promote?.rescheduleReason).toBeTruthy();

    // DEMOTE：滚入今日，降为 P1，写非空 rescheduleReason
    const demote = await prisma.planTask.findUnique({ where: { id: 't-demote' } });
    expect(demote?.planDate).toBe(AS_OF);
    expect(demote?.priority).toBe('P1');
    expect(demote?.status).toBe('TODO');
    expect(demote?.movedCount).toBe(1);
    expect(demote?.rescheduleReason).toBeTruthy();

    // BACKLOG：DEFERRED，deferReason + rescheduleReason 均非空，movedCount +1
    const backlog = await prisma.planTask.findUnique({ where: { id: 't-backlog' } });
    expect(backlog?.status).toBe('DEFERRED');
    expect(backlog?.deferReason).toBeTruthy();
    expect(backlog?.rescheduleReason).toBeTruthy();
    expect(backlog?.movedCount).toBe(1);

    // ABANDON：CANCELLED，deferReason + rescheduleReason 均非空
    const abandon = await prisma.planTask.findUnique({ where: { id: 't-abandon' } });
    expect(abandon?.status).toBe('CANCELLED');
    expect(abandon?.deferReason).toBeTruthy();
    expect(abandon?.rescheduleReason).toBeTruthy();
  });
});
