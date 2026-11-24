/**
 * T06b Q6 回归 —— ⑯⑰：双重写入守门。
 *
 * ⑯ 同一草案连续确认两次 → 只有一条 PlanTask。
 * ⑰ 材料页确认后该条目在候选池查询中不再出现（planTaskId IS NULL 过滤生效）。
 *
 * A-3：若有人把 `appendTaskFromCandidate` 的幂等删掉、或把候选池的 planTaskId
 * 过滤删掉，对应断言会红。走真库 —— 这两条都发生在 Prisma 的 where 里。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma } = await createTestDb([
  'studySessionDaySplit',
  'studySession',
  'taskProposalItem',
  'taskProposal',
  'planVersion',
  'planTask',
  'dailyBudget',
  'plannerSettings',
  'stage',
  'learningMaterial',
  'materialPackItem',
  'materialPack',
  'resource',
]);

const { confirmTaskProposalAction } = await import('@/lib/actions/materialPack');
const { collectMaterialCandidates } = await import('@/lib/services/candidateSources');

const PLAN_DATE = '2026-11-26';
const STAGE_ID = 'stage-nodouble';
const MATERIAL_ID = 'material-nodouble';

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S2_A2_B1',
      nameZh: '双重写入测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'A2_B1',
    },
  });
  await prisma.dailyBudget.create({
    data: { date: PLAN_DATE, plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.learningMaterial.create({
    data: {
      id: MATERIAL_ID,
      title: '双重写入材料',
      format: 'PASTED_TEXT',
      sourceType: 'user_provided_url',
      contentHash: 'nodouble-content-hash',
      status: 'ready',
    },
  });
  await prisma.taskProposal.create({
    data: {
      id: 'proposal-nodouble',
      materialId: MATERIAL_ID,
      baseDate: PLAN_DATE,
      budgetMinutes: 60,
      totalMinutes: 0,
      status: 'draft',
    },
  });
  await prisma.taskProposalItem.create({
    data: {
      id: 'item-nodouble',
      proposalId: 'proposal-nodouble',
      module: 'READING',
      targetSkill: 'READING',
      title: '双重写入条目',
      suggestedMinutes: 20,
      suggestedDate: PLAN_DATE,
      selected: true,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('T06b Q6 双重写入回归', () => {
  it('⑰ 确认前：条目在材料候选池中出现', async () => {
    const candidates = await collectMaterialCandidates({ asOfDate: PLAN_DATE });
    expect(candidates.some((c) => c.sourceRef === 'material:item-nodouble')).toBe(true);
  });

  it('⑯ 同一草案连续确认两次 → 只有一条 PlanTask', async () => {
    const first = await confirmTaskProposalAction({ proposalId: 'proposal-nodouble' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toBe(1);

    // 第二次：草案状态已 confirmed，入口层直接拒绝（不再写）
    const second = await confirmTaskProposalAction({ proposalId: 'proposal-nodouble' });
    expect(second.ok).toBe(false);

    const tasks = await prisma.planTask.findMany({ where: { planDate: PLAN_DATE } });
    expect(tasks.length).toBe(1);
    // 版本来自 writer 的 nextPlanVersion（此时无历史版本，故为 1）；
    // 关键是它经写入者产生、且同事务有 PlanVersion 审计，而非旧路径的硬编码字段缺失。
    expect(tasks[0].planVersion).toBe(1);
    const versions = await prisma.planVersion.findMany({ where: { planDate: PLAN_DATE } });
    expect(versions.length).toBe(1);
    expect(versions[0].reason).toContain('材料草案确认');
  });

  it('⑰ 确认后：该条目在候选池查询中不再出现', async () => {
    const item = await prisma.taskProposalItem.findUnique({ where: { id: 'item-nodouble' } });
    expect(item?.planTaskId).not.toBeNull();

    const candidates = await collectMaterialCandidates({ asOfDate: PLAN_DATE });
    expect(candidates.some((c) => c.sourceRef === 'material:item-nodouble')).toBe(false);
  });
});
