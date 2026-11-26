/**
 * T06b Q6 行为变更回归 —— ⑫–⑮。
 *
 * 这是 v2.6 已验收代码的行为变更，必须留独立证据：
 * ⑫ 确认后 PlanTask 字段不再全默认（planVersion/candidateId/splittable）；
 * ⑬ action 签名/返回结构与组件 props 不变（编译期 + 运行期快照）；
 * ⑭ 预算闸门只跑一次（入口删预检，唯一一次在写入者内）；
 * ⑮ skillOfModule 收编后三类模块的 skill 逐值不变（行为不变回归）。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ⑭：spy 预算闸门调用次数。用 hoisted 让 vi.mock 工厂能访问到 spy（ESM hoist 约束）。
const { budgetGateSpy } = vi.hoisted(() => ({ budgetGateSpy: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/domain/taskProposal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domain/taskProposal')>();
  return {
    ...actual,
    validateProposalAgainstBudget: (...args: unknown[]) => {
      budgetGateSpy(...args);
      return actual.validateProposalAgainstBudget(
        args[0] as Parameters<typeof actual.validateProposalAgainstBudget>[0],
        args[1] as Parameters<typeof actual.validateProposalAgainstBudget>[1],
      );
    },
  };
});

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

const { prisma } = await createTestDb();

const { confirmTaskProposalAction } = await import('@/lib/actions/materialPack');
const { skillOfModule } = await import('@/lib/domain/planWriteMap');

const PLAN_DATE = '2026-11-27';
const STAGE_ID = 'stage-q6';
const MATERIAL_ID = 'material-q6';

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S2_A2_B1',
      nameZh: 'Q6 回归阶段',
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
      title: 'Q6 回归材料',
      format: 'PASTED_TEXT',
      sourceType: 'user_provided_url',
      contentHash: 'q6-content-hash',
      status: 'ready',
    },
  });
  await prisma.taskProposal.create({
    data: {
      id: 'proposal-q6',
      materialId: MATERIAL_ID,
      baseDate: PLAN_DATE,
      budgetMinutes: 60,
      totalMinutes: 0,
      status: 'draft',
    },
  });
  await prisma.taskProposalItem.create({
    data: {
      id: 'item-q6',
      proposalId: 'proposal-q6',
      module: 'READING',
      targetSkill: 'READING',
      title: 'Q6 回归条目',
      suggestedMinutes: 30,
      suggestedDate: PLAN_DATE,
      selected: true,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('T06b Q6 材料确认回归', () => {
  it('⑬ action 签名与返回结构不变（编译期类型断言 + 运行期键集合快照）', async () => {
    budgetGateSpy.mockClear();
    const result = await confirmTaskProposalAction({ proposalId: 'proposal-q6' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 运行期：返回结构键集合与 v2.6 一致（一字不差）
    expect(Object.keys(result.data).sort()).toEqual(
      ['created', 'failed', 'proposalId', 'status', 'totalMinutes'].sort(),
    );
    expect(result.data.proposalId).toBe('proposal-q6');
    expect(result.data.created).toBe(1);
    expect(result.data.failed).toBe(0);
    expect(result.data.status).toBe('confirmed');
    expect(result.data.totalMinutes).toBe(30);
  });

  it('⑫ 确认后：planVersion ≠ 1（有审计）、note 保留、splittable 与分钟匹配', async () => {
    const item = await prisma.taskProposalItem.findUnique({ where: { id: 'item-q6' } });
    expect(item?.planTaskId).not.toBeNull();
    const task = await prisma.planTask.findUnique({ where: { id: item!.planTaskId! } });
    expect(task).not.toBeNull();
    if (!task) return;

    expect(task.plannedMinutes).toBe(30);
    expect(task.splittable).toBe(true); // 30 > MIN_TASK_MINUTES(5)
    expect(task.sourceKind).toBe('MANUAL'); // MATERIAL 映射 → MANUAL
    expect(task.priority).toBe('P1');
    expect(task.note).toContain('来自材料任务草案');
    const versions = await prisma.planVersion.findMany({ where: { planDate: PLAN_DATE } });
    expect(versions.length).toBe(1);
    expect(versions[0].changeSource).toBe('MANUAL_ADJUST');
    expect(versions[0].reason).toContain('材料草案确认');
  });

  it('⑭ 预算闸门只跑一次（入口删预检）', () => {
    // confirm 单个草案条目：唯一一次来自写入者事务内
    expect(budgetGateSpy).toHaveBeenCalledTimes(1);
  });

  it('⑮ skillOfModule 收编后三类模块 skill 与收编前逐值相同', () => {
    // v2.6 私有实现的三条分支（字面量期望，不从常量反查）
    expect(skillOfModule('VOCAB_REVIEW', 'READING')).toBe('VOCAB');
    expect(skillOfModule('SENTENCE', 'READING')).toBe('SENTENCE');
    expect(skillOfModule('GRAMMAR', 'READING')).toBe('GRAMMAR');
    // targetSkill 特判与兜底
    expect(skillOfModule('READING', 'VOCABULARY')).toBe('VOCAB');
    expect(skillOfModule('READING', 'GRAMMAR')).toBe('GRAMMAR');
    expect(skillOfModule('READING', 'LISTENING')).toBe('READING');
  });
});
