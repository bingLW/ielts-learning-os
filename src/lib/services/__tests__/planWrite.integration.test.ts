/**
 * T06b 唯一写入者（Q6）主证据 —— ⑧–⑪。
 *
 * 为什么走真库：`appendTaskFromCandidate` 的被测行为（事务原子性、预算闸门、
 * 幂等回填、同事务写 PlanVersion）全部发生在 Prisma 的 where/事务边界里。
 * mock 掉 prisma 等于把被测逻辑一起 mock 掉，测试会绿但什么都没证明。
 *
 * 三条写测试的自我约束（`41 §1.9`）：
 * - **A-1**：「预算超支零写入」断言前，先确认当日已有任务确实存在（集合非空）。
 * - **A-2**：期望值手抄字面量（P0/MANUAL、version=2、60 分钟），不从被测函数反查。
 * - **A-3**：每条断言都能说出"哪种错误实现会让它红"：
 *   ⑧ 漏写字段 → 字段断言红；⑨ 闸门漏跑 → 零写入断言红；
 *   ⑩ 幂等漏判 → 行数断言红；⑪ 审计漏写 → PlanVersion 断言红。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb();

const { appendTaskFromCandidate, appendTaskBatchInTransaction } = await import('@/lib/services/planWrite');

const PLAN_DATE = '2026-11-25';
const STAGE_ID = 'test-stage-t06b';
const MATERIAL_ID = 'material-t06b';

/** 唯一写入者的最小合法入参（⑧ 要验的字段全部显式给值）。 */
function baseInput(overrides: Partial<Parameters<typeof appendTaskFromCandidate>[0]> = {}) {
  return {
    stageId: STAGE_ID,
    planDate: PLAN_DATE,
    module: 'READING' as const,
    skill: 'READING' as const,
    plannedMinutes: 25,
    priority: 'P0' as const,
    sourceKind: 'RETEST' as const,
    track: 'IELTS_PREPARATION' as const,
    primarySkill: 'READING' as const,
    minChunkMinutes: 5,
    note: '到期证据复测',
    candidateId: 'cand-t06b-1',
    decisionJson: '{"score":0.88}',
    origin: 'CANDIDATE_CONFIRM' as const,
    ...overrides,
  };
}

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: 'T06b 测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'B1_B2',
    },
  });
  // 显式预算 60，非休息日——避免落到"系统建议 60"分支影响 warnings 断言
  await prisma.dailyBudget.create({
    data: { date: PLAN_DATE, plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.dailyBudget.create({
    data: { date: '2026-11-26', plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.learningMaterial.create({
    data: {
      id: MATERIAL_ID,
      title: 'T06b 测试材料',
      format: 'PASTED_TEXT',
      sourceType: 'user_provided_url',
      contentHash: 't06b-content-hash',
      status: 'ready',
    },
  });
  // A-3：先放一条 version=1 的历史版本。若写入者仍像 v2.6 那样硬编码 1，
  // ⑧ 的 version=2 断言就会红；没有这条种子，"第一条恰好是 1" 什么也证明不了。
  await prisma.planVersion.create({
    data: {
      planDate: PLAN_DATE,
      version: 1,
      changeSource: 'GENERATE',
      reason: '历史基线',
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('T06b appendTaskFromCandidate（Q6 唯一写入者）', () => {
  it('⑧ 写入后 17 字段全部非默认，且来自映射结果', async () => {
    const result = await appendTaskFromCandidate(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const task = await prisma.planTask.findUnique({ where: { id: result.data.taskId } });
    expect(task).not.toBeNull();
    if (!task) return;

    // ⑧ 手抄字面量：与 schema 默认值逐项不同
    expect(task.priority).toBe('P0'); // 默认 P1
    expect(task.sourceKind).toBe('RETEST'); // 默认 CORE
    expect(task.planVersion).toBe(2); // 默认 1；nextPlanVersion 看版本表+任务行
    expect(task.originalScheduledDate).toBe(PLAN_DATE); // 默认 null
    expect(task.splittable).toBe(true); // 25 > 5；默认 false
    expect(task.minChunkMinutes).toBe(5); // 显式同值，靠 splittable 反证已派生
    expect(task.track).toBe('IELTS_PREPARATION');
    expect(task.primarySkill).toBe('READING');
    expect(task.candidateId).toBe('cand-t06b-1');
    expect(task.decisionJson).toBe('{"score":0.88}');
    expect(task.status).toBe('TODO');
    expect(task.note).toBe('到期证据复测');
    expect(task.plannedMinutes).toBe(25);
    expect(task.module).toBe('READING');
    expect(task.skill).toBe('READING');
    expect(task.sortOrder).toBe(0);
    expect(task.stageId).toBe(STAGE_ID);

    expect(result.data.created).toBe(true);
    expect(result.data.plannedMinutesAfter).toBe(25);
  });

  it('⑨ 预算超支 → fail(PRECONDITION) 且零写入', async () => {
    // A-1：先确认"已有任务"确实非空，否则测的是空预算路径
    const before = await prisma.planTask.count({ where: { planDate: PLAN_DATE } });
    expect(before).toBe(1);

    // 当日预算 60，已有 25，再写 40 → 65 > 60
    const result = await appendTaskFromCandidate(baseInput({ plannedMinutes: 40 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(result.error).toContain('预算');

    const after = await prisma.planTask.count({ where: { planDate: PLAN_DATE } });
    expect(after).toBe(before); // 零写入
    const versions = await prisma.planVersion.count({ where: { planDate: PLAN_DATE } });
    expect(versions).toBe(2); // 种子 v1 + ⑧ 写的 v2；本次回滚不留痕
  });

  it('⑩ proposalItemId 重复调用 → created:false 且 PlanTask 行数不变', async () => {
    await prisma.taskProposal.create({
      data: {
        id: 'proposal-t06b',
        materialId: MATERIAL_ID,
        baseDate: PLAN_DATE,
        budgetMinutes: 60,
        totalMinutes: 0,
        status: 'draft',
      },
    });
    await prisma.taskProposalItem.create({
      data: {
        id: 'item-t06b',
        proposalId: 'proposal-t06b',
        module: 'READING',
        targetSkill: 'READING',
        title: '复测条目',
        suggestedMinutes: 10,
        suggestedDate: PLAN_DATE,
      },
    });

    const first = await appendTaskFromCandidate(
      baseInput({
        plannedMinutes: 10,
        proposalItemId: 'item-t06b',
        origin: 'MATERIAL_CONFIRM',
        sourceKind: 'MANUAL',
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toBe(true);

    const itemAfterFirst = await prisma.taskProposalItem.findUnique({
      where: { id: 'item-t06b' },
    });
    expect(itemAfterFirst?.planTaskId).toBe(first.data.taskId);

    const rowsBefore = await prisma.planTask.count({ where: { planDate: PLAN_DATE } });
    const second = await appendTaskFromCandidate(
      baseInput({
        plannedMinutes: 10,
        proposalItemId: 'item-t06b',
        origin: 'MATERIAL_CONFIRM',
        sourceKind: 'MANUAL',
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.created).toBe(false);
    expect(second.data.taskId).toBe(first.data.taskId);
    expect(await prisma.planTask.count({ where: { planDate: PLAN_DATE } })).toBe(rowsBefore);
  });

  it('⑪ 同事务写 PlanVersion(MANUAL_ADJUST, reason 含「材料草案确认」)', async () => {
    const versions = await prisma.planVersion.findMany({
      where: { planDate: PLAN_DATE },
      orderBy: { version: 'asc' },
    });
    // 三条版本：种子 v1 + ⑧ 写入 v2 + ⑩ 首次写入 v3（⑩ 第二次幂等不建版本）
    expect(versions.length).toBe(3);
    const materialVersion = versions.find((v) => v.changeSource === 'MANUAL_ADJUST');
    expect(materialVersion).toBeDefined();
    expect(materialVersion?.reason).toContain('材料草案确认');
    expect(materialVersion?.budgetMinutes).toBe(60);
    expect(materialVersion?.actualMinutesAtChange).toBe(0);
    expect(materialVersion?.afterSnapshot).toContain('sourceKind');
  });

  it('⑫ 同一 idempotencyKey 并发重放 → 真 SQLite 唯一约束下只写入一次', async () => {
    const idempotencyKey = 'plan-write-concurrent-t06b';
    const tasksBefore = await prisma.planTask.count({ where: { planDate: PLAN_DATE } });
    const versionsBefore = await prisma.planVersion.count({ where: { planDate: PLAN_DATE } });
    const input = baseInput({ idempotencyKey, plannedMinutes: 10 });

    const results = await Promise.all([
      appendTaskFromCandidate(input),
      appendTaskFromCandidate(input),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    const created = results.filter((result) => result.ok && result.data.created);
    const replayed = results.filter((result) => result.ok && !result.data.created);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    const createdResult = created[0];
    const replayedResult = replayed[0];
    if (!createdResult?.ok || !replayedResult?.ok) throw new Error('并发重放未全部返回成功');
    expect(replayedResult.data.taskId).toBe(createdResult.data.taskId);

    expect(await prisma.planTask.count({ where: { planDate: PLAN_DATE } })).toBe(tasksBefore + 1);
    expect(await prisma.planVersion.count({ where: { planDate: PLAN_DATE } })).toBe(versionsBefore + 1);
    const persisted = await prisma.planVersion.findUnique({ where: { idempotencyKey } });
    expect(persisted?.version).toBe(createdResult.data.planVersion);
    expect(replayedResult.data.planVersion).toBe(createdResult.data.planVersion);
  });

  it('DONE 任务按实际分钟占用预算，不按原计划分钟少算', async () => {
    const planDate = '2026-11-26';
    await prisma.planTask.create({
      data: {
        id: 'done-actual-budget',
        stageId: STAGE_ID,
        planDate,
        module: 'LISTENING',
        skill: 'LISTENING',
        plannedMinutes: 20,
        actualMinutes: 40,
        status: 'DONE',
        priority: 'P1',
        sourceKind: 'CORE',
        splittable: true,
        minChunkMinutes: 5,
        sortOrder: 0,
        planVersion: 1,
        track: 'IELTS_PREPARATION',
        primarySkill: 'LISTENING',
      },
    });

    const result = await appendTaskFromCandidate(baseInput({ planDate, plannedMinutes: 20 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plannedMinutesAfter).toBe(60);
    const version = await prisma.planVersion.findFirst({ where: { version: result.data.planVersion, planDate } });
    expect(JSON.parse(version?.afterSnapshot ?? '{}')).toMatchObject({ plannedMinutesAfter: 60 });
  });

  it('P1-1 单任务 plannedMinutes=minChunkMinutes 时不可拆，幂等回放保留原值', async () => {
    const input = baseInput({
      planDate: '2026-11-27', plannedMinutes: 5, minChunkMinutes: 5,
      splittable: false, idempotencyKey: 'atomic-single-splittability',
    });
    const first = await appendTaskFromCandidate(input);
    const replay = await appendTaskFromCandidate({ ...input, splittable: true });
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.data.created).toBe(false);
    expect(replay.data.splittable).toBe(false);
    const task = await prisma.planTask.findUniqueOrThrow({ where: { id: first.data.taskId } });
    expect(task.splittable).toBe(false);
    expect(task.minChunkMinutes).toBe(5);
  });

  it('P1-1 批量写入逐任务保留 splittable，不按计划分钟重算', async () => {
    const result = await prisma.$transaction((tx) => appendTaskBatchInTransaction(tx, [
      baseInput({ planDate: '2026-11-27', plannedMinutes: 5, minChunkMinutes: 5, splittable: false }),
      baseInput({ planDate: '2026-11-27', plannedMinutes: 10, minChunkMinutes: 5, splittable: true }),
    ], { primaryPlanDate: '2026-11-27', budgetPrevalidated: true }));
    expect(result.taskIds).toHaveLength(2);
    const tasks = await prisma.planTask.findMany({ where: { id: { in: result.taskIds } }, orderBy: { sortOrder: 'asc' } });
    expect(tasks.map((task) => ({ minutes: task.plannedMinutes, splittable: task.splittable }))).toEqual([
      { minutes: 5, splittable: false },
      { minutes: 10, splittable: true },
    ]);
  });
});
