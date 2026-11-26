import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import { READINESS_RULE_VERSION, type ReadinessDimensionCode } from '@/lib/domain/readiness';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const { prisma, cleanup } = await createTestDb();
const { reviewReadinessAction, confirmStageTransitionAction } = await import('@/lib/actions/planner');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-readiness';
const CODES: ReadinessDimensionCode[] = ['D1_EVIDENCE_COVERAGE', 'D2_CROSS_SOURCE_CONSISTENCY', 'D3_INDEPENDENT_COMPLETION', 'D4_DELAYED_RETENTION', 'D5_TRANSFER_EVIDENCE'];

beforeAll(async () => {
  await prisma.stage.create({ data: { id: STAGE_ID, code: 'S1_A0_A2', nameZh: 'readiness 测试阶段', estDaysMin: 30, status: 'ACTIVE', profileCode: 'A0_A2' } });
  await prisma.stage.create({ data: { id: 'stage-target', code: 'S2_A2_B1', nameZh: '目标阶段', estDaysMin: 30, status: 'NOT_STARTED', profileCode: 'A2_B1' } });
});
afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

async function createReview(options: { outcome?: string; status?: string; stageId?: string } = {}) {
  const stageId = options.stageId ?? STAGE_ID;
  const snapshot = await prisma.planningSnapshot.create({ data: {
    purpose: 'READINESS', asOfDate: AS_OF, inputHash: `review-${Math.random()}`,
    ruleVersion: READINESS_RULE_VERSION, budgetJson: '{}', configJson: '{}',
  } });
  return prisma.stageReadinessReview.create({ data: {
    stageId, snapshotId: snapshot.id, outcome: options.outcome ?? 'READY_FOR_REVIEW',
    ruleVersion: READINESS_RULE_VERSION,
    criteriaJson: JSON.stringify({ schemaVersion: 2, dimensions: CODES.map((code) => ({
      code, label: code, status: options.status ?? 'PASS', detail: '测试快照', evidenceRefs: ['ev-1'], suggestion: '补测',
    })) }),
  } });
}

beforeEach(async () => {
  await prisma.stage.updateMany({ data: { status: 'NOT_STARTED', completedAt: null } });
  await prisma.stage.update({ where: { id: STAGE_ID }, data: { status: 'ACTIVE', startedAt: '2026-01-01' } });
  await prisma.stage.update({ where: { id: 'stage-target' }, data: { status: 'NOT_STARTED', startedAt: null } });
});

describe('AC-03 评审快照', () => {
  it('空库评审仍落库；蓝图缺失为 D1 READ_ERROR，不伪造 0% 或 READY', async () => {
    const result = await reviewReadinessAction({ stageId: STAGE_ID, asOfDate: AS_OF });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('NEED_MORE_EVIDENCE');
    const review = await prisma.stageReadinessReview.findUniqueOrThrow({ where: { id: result.data.reviewId } });
    const criteria = JSON.parse(review.criteriaJson) as { schemaVersion: number; dimensions: Array<{ code: string; status: string }>; snapshot: { ruleVersion: string; dataSnapshotId: string; coverageBySkill: Record<string, { coverageRatio: number | null }> } };
    expect(criteria.schemaVersion).toBe(2);
    expect(criteria.dimensions).toHaveLength(5);
    expect(criteria.dimensions.find((row) => row.code === 'D1_EVIDENCE_COVERAGE')?.status).toBe('READ_ERROR');
    expect(criteria.snapshot.ruleVersion).toBe(review.ruleVersion);
    expect(criteria.snapshot.dataSnapshotId).toBe(review.snapshotId);
    expect(Object.values(criteria.snapshot.coverageBySkill).every((row) => row.coverageRatio === null)).toBe(true);
  });

  it('历史 review 不因新增证据而变化', async () => {
    const review = await createReview({ outcome: 'NEED_MORE_EVIDENCE', status: 'INSUFFICIENT' });
    const before = review.criteriaJson;
    await prisma.evidenceRecord.create({ data: { skill: 'LISTENING', evidenceType: 'BASELINE', score: 2, outputText: 'new evidence' } });
    const after = await prisma.stageReadinessReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.criteriaJson).toBe(before);
  });
});

describe('阶段确认门禁', () => {
  it('READY + 用户确认才写 USER_APPROVED_TRANSITION 和 StageTransitionLog', async () => {
    const review = await createReview();
    const confirm = await confirmStageTransitionAction({ reviewId: review.id, toStageCode: 'S2_A2_B1', reason: '证据已满足，用户本人确认进入下一阶段', confirmedBy: '本人' });
    expect(confirm.ok).toBe(true);
    if (!confirm.ok) return;
    const updated = await prisma.stageReadinessReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated.outcome).toBe('USER_APPROVED_TRANSITION');
    expect(updated.userConfirmed).toBe(true);
    const log = await prisma.stageTransitionLog.findUniqueOrThrow({ where: { id: confirm.data.logId } });
    expect(log.evidenceSnapshot).toBe(updated.criteriaJson);
    expect((await prisma.stage.findUniqueOrThrow({ where: { id: STAGE_ID } })).status).toBe('COMPLETED');
    expect((await prisma.stage.findUniqueOrThrow({ where: { code: 'S2_A2_B1' } })).status).toBe('ACTIVE');
  });

  it.each([
    ['NEED_MORE_EVIDENCE', 'INSUFFICIENT'],
    ['READY_FOR_REVIEW', 'READ_ERROR'],
    ['CONTINUE_CURRENT', 'FAIL'],
  ])('非 READY 或存在 READ_ERROR（%s/%s）拒绝切换且不写日志', async (outcome, status) => {
    const review = await createReview({ outcome, status });
    const count = await prisma.stageTransitionLog.count();
    const result = await confirmStageTransitionAction({ reviewId: review.id, toStageCode: 'S2_A2_B1', reason: '尝试绕过就绪门禁但应被拒绝', confirmedBy: '本人' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PRECONDITION');
    expect(await prisma.stageTransitionLog.count()).toBe(count);
    expect((await prisma.stage.findUniqueOrThrow({ where: { id: STAGE_ID } })).status).toBe('ACTIVE');
  });

  it('criteriaJson 损坏时拒绝切换（fail closed）', async () => {
    const review = await createReview();
    await prisma.stageReadinessReview.update({ where: { id: review.id }, data: { criteriaJson: '{broken' } });
    const result = await confirmStageTransitionAction({ reviewId: review.id, toStageCode: 'S2_A2_B1', reason: '损坏快照不得通过确认', confirmedBy: '本人' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PRECONDITION');
  });

  it('评审不属于当前 ACTIVE 阶段时拒绝切换', async () => {
    const review = await createReview({ stageId: 'stage-target' });
    const result = await confirmStageTransitionAction({ reviewId: review.id, toStageCode: 'S2_A2_B1', reason: '非当前阶段评审不得确认', confirmedBy: '本人' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PRECONDITION');
  });

  it('重复确认同一 review → CONFLICT', async () => {
    const review = await createReview();
    const payload = { reviewId: review.id, toStageCode: 'S2_A2_B1', reason: '证据已满足，用户本人确认进入下一阶段', confirmedBy: '本人' };
    expect((await confirmStageTransitionAction(payload)).ok).toBe(true);
    const second = await confirmStageTransitionAction(payload);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('CONFLICT');
  });
});
