import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const { prisma, cleanup } = await createTestDb();
const { persistReadinessReview } = await import('@/lib/services/readiness');
const { ensureDiagnosticBank } = await import('@/lib/diagnostic/bank');

const AS_OF = '2026-11-25';
const STAGE_ID = 'readiness-stage';

beforeAll(async () => {
  await prisma.stage.create({ data: { id: STAGE_ID, code: 'S1_A0_A2', nameZh: 'A0–A2', estDaysMin: 30, profileCode: 'A0_A2', status: 'ACTIVE' } });
});
afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

async function review(timeZone = 'UTC', asOfDate = AS_OF) {
  const result = await persistReadinessReview({ stageId: STAGE_ID, asOfDate, timeZone });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe('AC-03 readiness 真实数据装配', () => {
  it('蓝图已知且零完成时覆盖率为 0；未知蓝图时为 null + READ_ERROR', async () => {
    const missing = await review();
    expect(Object.values(missing.result.snapshot.coverageBySkill).every((row) => row.coverageRatio === null)).toBe(true);
    expect(missing.result.dimensions.find((row) => row.code === 'D1_EVIDENCE_COVERAGE')?.status).toBe('READ_ERROR');

    const { blueprintId } = await ensureDiagnosticBank(prisma);
    const empty = await review();
    expect(empty.result.snapshot.blueprint.id).toBe(blueprintId);
    expect(Object.values(empty.result.snapshot.coverageBySkill).every((row) => row.required > 0 && row.coverageRatio === 0)).toBe(true);
    expect(empty.result.dimensions.find((row) => row.code === 'D1_EVIDENCE_COVERAGE')?.status).toBe('INSUFFICIENT');
    expect(empty.result.dimensions.find((row) => row.code === 'D1_EVIDENCE_COVERAGE')?.detail).toContain('0%');
  });

  it('有效 Attempt 按 item.subskill 计入分子，INVALID/未完成会话不计入且记录原因', async () => {
    await ensureDiagnosticBank(prisma);
    const item = await prisma.diagnosticItem.findUniqueOrThrow({ where: { itemCode: 'L-DETAIL-A2' } });
    const completed = await prisma.diagnosticSession.create({ data: { blueprintId: item.blueprintId, status: 'COMPLETED', completedAt: new Date('2026-11-20T00:00:00Z') } });
    const active = await prisma.diagnosticSession.create({ data: { blueprintId: item.blueprintId, status: 'IN_PROGRESS' } });
    const valid = await prisma.diagnosticAttempt.create({ data: {
      sessionId: completed.id, itemId: item.id, sequence: 1, status: 'SCORED', score: 1, maxScore: 2,
      responseText: 'B', submittedAt: new Date('2026-11-20T00:00:00Z'),
    } });
    await prisma.diagnosticAttempt.create({ data: {
      sessionId: completed.id, itemId: item.id, sequence: 2, status: 'INVALID', technicalStatusJson: JSON.stringify({ technicalFailed: true, reason: '录音损坏' }),
      submittedAt: new Date('2026-11-20T00:00:00Z'),
    } });
    await prisma.diagnosticAttempt.create({ data: {
      sessionId: active.id, itemId: item.id, sequence: 1, status: 'SCORED', score: 2, maxScore: 2,
      responseText: 'B', submittedAt: new Date('2026-11-20T00:00:00Z'),
    } });
    const result = await review();
    const listening = result.result.snapshot.coverageBySkill.LISTENING!;
    expect(listening.completed).toBe(1);
    expect(listening.coverageRatio).toBe(1 / listening.required);
    expect(listening.dimensions.find((row) => row.subskill === 'detail_understanding')?.evidenceRefs).toContain(valid.id);
    expect(result.result.snapshot.invalidSamples.some((row) => row.reason === '录音损坏')).toBe(true);
    expect(result.result.snapshot.invalidSamples.some((row) => row.reason === '诊断会话未完成')).toBe(true);
  });

  it('Evidence 的 subskill 可追溯；A1 或 toolsAllowed 非空不计入 D3', async () => {
    await ensureDiagnosticBank(prisma);
    await prisma.evidenceRecord.createMany({ data: [
      { skill: 'READING', evidenceType: 'BASELINE', score: 2, outputText: '答案', assistanceLevel: 'A1', conditionJson: JSON.stringify({ subskill: 'locating_details' }), createdAt: new Date('2026-11-20T00:00:00Z') },
      { skill: 'READING', evidenceType: 'BASELINE', score: 2, outputText: '答案', assistanceLevel: 'A0', conditionJson: JSON.stringify({ subskill: 'locating_details', toolsAllowed: ['词典'] }), createdAt: new Date('2026-11-20T00:00:00Z') },
      { skill: 'READING', evidenceType: 'BASELINE', score: 2, outputText: '答案', assistanceLevel: 'A0', conditionJson: JSON.stringify({ subskill: 'locating_details', toolsAllowed: [] }), createdAt: new Date('2026-11-20T00:00:00Z') },
    ] });
    const result = await review();
    expect(result.result.snapshot.coverageBySkill.READING?.dimensions.find((row) => row.subskill === 'locating_details')?.evidenceRefs).toHaveLength(3);
    const stored = JSON.parse((await prisma.stageReadinessReview.findUniqueOrThrow({ where: { id: result.reviewId } })).criteriaJson) as { snapshot: { coverageBySkill: Record<string, { dimensions: Array<{ evidenceRefs: string[] }> }> } };
    expect(stored.snapshot.coverageBySkill.READING).toBeDefined();
    expect(result.result.dimensions.find((row) => row.code === 'D3_INDEPENDENT_COMPLETION')?.status).toBe('INSUFFICIENT');
  });

  it('同一材料方向冲突保持未知；无来源的重复 AI 答案不增加独立来源', async () => {
    await ensureDiagnosticBank(prisma);
    const rows = [
      { score: 2, materialSource: '冲突材料', evidenceType: 'BASELINE' },
      { score: 0, materialSource: '冲突材料', evidenceType: 'IMMEDIATE_RETEST' },
      { score: 2, materialSource: '冲突材料', evidenceType: 'DELAYED_RETEST' },
      { score: 2, materialSource: '另一材料', evidenceType: 'BASELINE' },
      { score: 2, materialSource: null, evidenceType: 'BASELINE' },
    ];
    for (const [index, row] of rows.entries()) {
      await prisma.evidenceRecord.create({ data: {
        skill: 'READING', evidenceType: row.evidenceType, score: row.score, outputText: 'AI 相同答案', assistanceLevel: 'A0',
        conditionJson: JSON.stringify({ subskill: 'locating_details', prompt: `任务 ${index}`, ...(row.materialSource ? { materialSource: row.materialSource } : {}) }),
        createdAt: new Date('2026-11-20T00:00:00Z'),
      } });
    }
    const result = await review();
    const snapshot = await prisma.planningSnapshot.findUniqueOrThrow({ where: { id: result.result.snapshot.dataSnapshotId } });
    if (!snapshot.profileJson) throw new Error('就绪快照缺少 profileJson');
    const profile = JSON.parse(snapshot.profileJson) as { distinctSources: Array<{ skill: string; sourceRefs: string[]; observations: Array<{ sourceRef: string; direction: string }> }> };
    const reading = profile.distinctSources.find((row) => row.skill === 'READING');
    expect([...(reading?.sourceRefs ?? [])].sort()).toEqual(['material:冲突材料', 'material:另一材料']);
    expect(reading?.observations.find((row) => row.sourceRef === 'material:冲突材料')?.direction).toBe('UNKNOWN');
    expect(result.result.dimensions.find((row) => row.code === 'D2_CROSS_SOURCE_CONSISTENCY')?.detail).not.toContain('READING（独立来源 0）');
  });

  it('D4/D5 只接受到期、A0、新 prompt/材料的已完成复测', async () => {
    await ensureDiagnosticBank(prisma);
    const parent = await prisma.evidenceRecord.create({ data: {
      skill: 'LISTENING', evidenceType: 'BASELINE', score: 2, outputText: 'baseline', assistanceLevel: 'A0',
      conditionJson: JSON.stringify({ prompt: 'Describe your hometown', materialSource: 'Cambridge 15' }),
      createdAt: new Date('2026-11-01T00:00:00Z'),
    } });
    const completed = await prisma.evidenceRecord.create({ data: {
      skill: 'LISTENING', evidenceType: 'DELAYED_RETEST', score: 2, scoreReason: '独立完成', outputText: 'notes', assistanceLevel: 'A0',
      conditionJson: JSON.stringify({ prompt: 'Describe a new city', materialSource: 'BBC 6 Minute English' }),
      createdAt: new Date('2026-11-10T00:00:00Z'),
    } });
    await prisma.retestSchedule.create({ data: {
      parentEvidenceId: parent.id, retestType: 'DELAYED', dueDate: '2026-11-08', status: 'DONE',
      idempotencyKey: `${parent.id}:DELAYED:2026-11-08`,
      completedEvidenceId: completed.id, completedAt: new Date('2026-11-10T00:00:00Z'),
    } });
    const repeated = await prisma.evidenceRecord.create({ data: {
      skill: 'LISTENING', evidenceType: 'TRANSFER', score: 2, scoreReason: '独立完成', outputText: 'same task', assistanceLevel: 'A0',
      conditionJson: JSON.stringify({ prompt: 'Describe your hometown', materialSource: 'Cambridge 15' }),
      createdAt: new Date('2026-11-10T00:00:00Z'),
    } });
    await prisma.retestSchedule.create({ data: {
      parentEvidenceId: parent.id, retestType: 'TRANSFER', dueDate: '2026-11-08', status: 'DONE',
      idempotencyKey: `${parent.id}:TRANSFER:2026-11-08`,
      completedEvidenceId: repeated.id, completedAt: new Date('2026-11-10T00:00:00Z'),
    } });
    const result = await review();
    expect(result.result.dimensions.find((row) => row.code === 'D4_DELAYED_RETENTION')?.status).toBe('PASS');
    expect(result.result.dimensions.find((row) => row.code === 'D5_TRANSFER_EVIDENCE')?.status).toBe('INSUFFICIENT');
    expect(result.result.snapshot.invalidSamples.some((row) => row.id === repeated.id && row.reason?.includes('重复原题'))).toBe(true);
  });

  it('同一数据快照可复用，review append-only 且规则版本显式继承', async () => {
    const first = await review();
    const second = await review();
    expect(second.result.snapshot.dataSnapshotId).toBe(first.result.snapshot.dataSnapshotId);
    expect(second.reviewId).not.toBe(first.reviewId);
    const row = await prisma.stageReadinessReview.findUniqueOrThrow({ where: { id: second.reviewId } });
    expect(row.ruleVersion).toBe(second.result.snapshot.ruleVersion);
    expect(await prisma.stageReadinessReview.count({ where: { snapshotId: row.snapshotId } })).toBeGreaterThanOrEqual(2);
  });
});

describe('IANA 业务日：证据查询上界', () => {
  it.each([
    { name: '春季 DST 23 小时日', timeZone: 'America/New_York', asOfDate: '2026-03-08', inside: '2026-03-09T03:59:59.999Z', outside: '2026-03-09T04:00:00.000Z' },
    { name: '秋季 DST 25 小时日', timeZone: 'America/New_York', asOfDate: '2026-11-01', inside: '2026-11-02T04:59:59.999Z', outside: '2026-11-02T05:00:00.000Z' },
    { name: '东八区业务日界', timeZone: 'Asia/Shanghai', asOfDate: '2026-11-25', inside: '2026-11-25T15:59:59.999Z', outside: '2026-11-25T16:00:00.000Z' },
  ])('$name：Attempt 与 Evidence 均包含日界前、排除次日午夜', async ({ timeZone, asOfDate, inside, outside }) => {
    await ensureDiagnosticBank(prisma);
    const item = await prisma.diagnosticItem.findUniqueOrThrow({ where: { itemCode: 'L-DETAIL-A2' } });
    const session = await prisma.diagnosticSession.create({
      data: { blueprintId: item.blueprintId, status: 'COMPLETED', completedAt: new Date(inside) },
    });
    const insideAttempt = await prisma.diagnosticAttempt.create({ data: {
      sessionId: session.id, itemId: item.id, sequence: 1, status: 'SCORED', score: 1, maxScore: 2,
      responseText: 'B', submittedAt: new Date(inside),
    } });
    const outsideAttempt = await prisma.diagnosticAttempt.create({ data: {
      sessionId: session.id, itemId: item.id, sequence: 2, status: 'SCORED', score: 1, maxScore: 2,
      responseText: 'B', submittedAt: new Date(outside),
    } });
    const insideEvidence = await prisma.evidenceRecord.create({ data: {
      skill: 'LISTENING', evidenceType: 'BASELINE', score: 2, outputText: '答案', assistanceLevel: 'A0',
      conditionJson: JSON.stringify({ subskill: 'detail_understanding' }), createdAt: new Date(inside),
    } });
    const outsideEvidence = await prisma.evidenceRecord.create({ data: {
      skill: 'LISTENING', evidenceType: 'BASELINE', score: 2, outputText: '答案', assistanceLevel: 'A0',
      conditionJson: JSON.stringify({ subskill: 'detail_understanding' }), createdAt: new Date(outside),
    } });

    const result = await review(timeZone, asOfDate);
    const refs = result.result.snapshot.coverageBySkill.LISTENING?.dimensions
      .find((row) => row.subskill === 'detail_understanding')?.evidenceRefs ?? [];
    expect(refs).toContain(insideAttempt.id);
    expect(refs).toContain(insideEvidence.id);
    expect(refs).not.toContain(outsideAttempt.id);
    expect(refs).not.toContain(outsideEvidence.id);
  });
});

describe('IANA 业务日：复测间隔', () => {
  it('completedAt 与 dueDate 按同一用户时区比较，跨 UTC 日界不误判', async () => {
    const parent = await prisma.evidenceRecord.create({ data: {
      skill: 'LISTENING', evidenceType: 'BASELINE', score: 2, outputText: 'baseline', assistanceLevel: 'A0',
      conditionJson: JSON.stringify({ prompt: 'Describe your hometown', materialSource: 'Cambridge 15' }),
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
    } });
    const completedAt = new Date('2026-11-02T04:30:00.000Z');
    const completed = await prisma.evidenceRecord.create({ data: {
      skill: 'LISTENING', evidenceType: 'DELAYED_RETEST', score: 2, outputText: 'new task', assistanceLevel: 'A0',
      conditionJson: JSON.stringify({ prompt: 'Describe a new city', materialSource: 'BBC 6 Minute English' }),
      createdAt: completedAt,
    } });
    const schedule = await prisma.retestSchedule.create({ data: {
      parentEvidenceId: parent.id, completedEvidenceId: completed.id, retestType: 'DELAYED',
      dueDate: '2026-11-02', status: 'DONE', completedAt,
      idempotencyKey: `${parent.id}:timezone-boundary`,
    } });

    async function outcome(timeZone: string) {
      const result = await review(timeZone);
      const snapshot = await prisma.planningSnapshot.findUniqueOrThrow({ where: { id: result.result.snapshot.dataSnapshotId } });
      const workload = JSON.parse(snapshot.workloadJson ?? '{}') as {
        retestOutcomes: Array<{ id: string; intervalMet: boolean; valid: boolean; invalidReason: string | null }>;
      };
      return workload.retestOutcomes.find((row) => row.id === schedule.id);
    }

    const newYork = await outcome('America/New_York');
    expect(newYork).toMatchObject({ intervalMet: false, invalidReason: '未达到规定复测间隔' });
    const shanghai = await outcome('Asia/Shanghai');
    expect(shanghai).toMatchObject({ intervalMet: true, invalidReason: null });
  });
});
