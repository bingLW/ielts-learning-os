import { addDays } from '@/lib/date';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb();
const { generatePlanPreviewAction, confirmPlanVersionAction } = await import('@/lib/actions/planner');
const { buildPlanningSnapshot } = await import('@/lib/services/planningSnapshot');

const STAGE_ID = 'stage-proposal';
const TIME_ZONE = 'Asia/Singapore';
const TASK_37 = {
  title: '  用户改写：听力结论句训练  ',
  minutes: 37,
  skill: 'LISTENING',
  evidenceRef: 'EvidenceChain:用户选择-07',
  reason: '  用户理由：先解决结论句，再补连接词。  ',
};
const TASK_18 = {
  title: '用户改写：阅读长句复盘',
  minutes: 18,
  skill: 'READING',
  evidenceRef: 'SkillProfile:READING',
  reason: '用户理由：每天复盘一个长句。',
};

beforeAll(async () => {
  await prisma.stage.create({
    data: { id: STAGE_ID, code: 'S3_B1_IELTS', nameZh: '提案集成阶段', estDaysMin: 30, status: 'ACTIVE' },
  });
  await prisma.plannerSettings.create({
    data: { id: 1, defaultDailyMinutes: 10, minTaskMinutes: 5, isUserConfirmed: true },
  });
  await prisma.userProfile.create({ data: { id: 1, timezone: TIME_ZONE } });
});

beforeEach(async () => {
  await prisma.planTask.deleteMany();
  await prisma.planVersion.deleteMany();
  await prisma.retestSchedule.deleteMany();
  await prisma.reviewTask.deleteMany();
  await prisma.evidenceRecord.deleteMany();
  await prisma.studySession.deleteMany();
  await prisma.planProposal.deleteMany();
  await prisma.placementReport.deleteMany();
  await prisma.diagnosticSession.deleteMany();
  await prisma.dailyBudget.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

async function setupDate(asOfDate: string, dailyMinutes = 10) {
  await prisma.dailyBudget.createMany({
    data: Array.from({ length: 7 }, (_, index) => ({
      date: addDays(asOfDate, index),
      plannedAvailableMinutes: dailyMinutes,
      isRestDay: dailyMinutes === 0,
      source: 'USER',
    })),
  });
}

function tasksJson(tasks = [TASK_37, TASK_18]) {
  return JSON.stringify([{ window: '7D', focus: '用户编辑后的启动阶段', tasks }]);
}

async function createProposal(asOfDate: string, tasks = [TASK_37, TASK_18]) {
  const session = await prisma.diagnosticSession.create({
    data: { id: `session-${asOfDate}`, status: 'COMPLETED' },
  });
  const report = await prisma.placementReport.create({
    data: {
      sessionId: session.id,
      summary: '提案集成测试报告',
      createdAt: new Date(`${asOfDate}T00:00:00.000Z`),
    },
  });
  return prisma.planProposal.create({
    data: {
      id: `proposal-${asOfDate}`,
      reportId: report.id,
      horizonDays: 7,
      tasksJson: tasksJson(tasks),
    },
  });
}

function input(asOfDate: string, proposalId: string) {
  return {
    purpose: 'GENERATE' as const,
    asOfDate,
    horizonDays: 7,
    stageId: STAGE_ID,
    proposalId,
    allowAi: false,
  };
}

describe('诊断提案进入统一 Planner', () => {
  it('预览零写正式计划，保留编辑字段，只排提案与到期复习/复测，跨日不重复生成完整任务', async () => {
    const asOfDate = '2026-11-27';
    await setupDate(asOfDate, 20);
    const proposal = await createProposal(asOfDate);
    await prisma.reviewTask.create({
      data: {
        id: 'review-proposal-test',
        targetType: 'VOCAB_WORD',
        targetId: 'word-1',
        targetLabel: '到期词汇复习',
        intervalCode: 'D1',
        dueDate: asOfDate,
        estMinutes: 5,
      },
    });
    const evidence = await prisma.evidenceRecord.create({
      data: { skill: 'READING', evidenceType: 'PRACTICE', assistanceLevel: 'A0', score: 5 },
    });
    await prisma.retestSchedule.create({
      data: {
        id: 'retest-proposal-test',
        parentEvidenceId: evidence.id,
        retestType: 'IMMEDIATE',
        dueDate: asOfDate,
        estMinutes: 10,
        idempotencyKey: 'proposal-test-retest',
      },
    });
    for (let index = 0; index < 3; index += 1) {
      await prisma.studySession.create({
        data: {
          startedAt: new Date(`${asOfDate}T10:00:00.000Z`),
          endedAt: new Date(`${asOfDate}T12:00:00.000Z`),
          activeMinutes: 100,
          terminatedReason: 'COMPLETED',
          sessionDate: asOfDate,
          skill: 'LISTENING',
          daySplits: { create: [{ date: asOfDate, minutes: 100 }] },
        },
      });
    }

    const before = {
      tasks: await prisma.planTask.count(),
      versions: await prisma.planVersion.count(),
      snapshots: await prisma.planningSnapshot.count(),
    };
    const preview = await generatePlanPreviewAction(input(asOfDate, proposal.id));
    expect(preview.ok, preview.ok ? undefined : preview.error).toBe(true);
    if (!preview.ok) return;

    expect(await prisma.planTask.count()).toBe(before.tasks);
    expect(await prisma.planVersion.count()).toBe(before.versions);
    expect(await prisma.planningSnapshot.count()).toBe(before.snapshots);
    expect((await prisma.planProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('DRAFT');
    expect(preview.data.aiMode).toBe('off');
    expect(preview.data.proposal).toMatchObject({
      id: proposal.id,
      window: '7D',
      taskCount: 2,
      scheduledTaskCount: 2,
      totalMinutes: 55,
      scheduledMinutes: 55,
    });
    expect(preview.data.days).toHaveLength(7);

    const tasks = preview.data.days.flatMap((day) => day.tasks);
    expect(new Set(tasks.map((task) => task.sourceKind))).toEqual(new Set(['REVIEW', 'RETEST', 'MANUAL']));
    expect(tasks.reduce((sum, task) => sum + task.plannedMinutes, 0)).toBe(70);
    for (const day of preview.data.days) {
      expect(day.tasks.reduce((sum, task) => sum + task.plannedMinutes, 0)).toBeLessThanOrEqual(20);
      expect(day.tasks.every((task) => task.plannedMinutes >= 5)).toBe(true);
    }

    const proposalTasks = tasks.filter((task) => task.explanation.candidateMeta?.diagnosticProposal);
    expect(proposalTasks.map((task) => task.title)).toEqual(expect.arrayContaining([TASK_37.title, TASK_18.title]));
    for (const task of proposalTasks) {
      expect(task.explanation.origin).toBe('USER_EDIT');
      expect(task.explanation.reason).toMatch(/^USER_EDIT：/);
    }
    const totalsByKey = new Map<string, number>();
    for (const task of proposalTasks) {
      totalsByKey.set(task.candidateKey!, (totalsByKey.get(task.candidateKey!) ?? 0) + task.plannedMinutes);
    }
    expect([...totalsByKey.values()].sort((a, b) => a - b)).toEqual([18, 37]);
    const listening = proposalTasks.find((task) => task.title === TASK_37.title)!;
    expect(listening.explanation.estMinutes).toBe(37);
    expect(listening.explanation.estimate).toMatchObject({ basis: 'ESTIMATE', sampleCount: 0, pointMinutes: 37 });
    expect(listening.explanation.candidateMeta?.diagnosticProposal).toMatchObject({
      evidenceRef: TASK_37.evidenceRef,
      userReason: TASK_37.reason,
    });

    const snapshot = await buildPlanningSnapshot({
      purpose: 'GENERATE', asOfDate, timeZone: TIME_ZONE, horizonDays: 7, stageId: STAGE_ID,
      proposalId: proposal.id, persist: false,
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.data.context.proposal?.fingerprint).toBe(preview.data.proposal?.fingerprint);
    expect(new Set(snapshot.data.context.candidates.map((candidate) => candidate.sourceKind)))
      .toEqual(new Set(['REVIEW', 'RETEST', 'MATERIAL']));
    const decision = snapshot.data.context.decisions.find((row) => row.meta.candidateMeta?.diagnosticProposal?.order === 0)!;
    expect(decision.rationale).toBe(`USER_EDIT：${TASK_37.reason}`);
    expect(decision.meta.evidenceRefs).toEqual([TASK_37.evidenceRef]);
  });

  it('确认事务写入正式计划并激活草案，标题、理由、证据引用与总分钟保持可审计', async () => {
    const asOfDate = '2026-11-28';
    await setupDate(asOfDate);
    const proposal = await createProposal(asOfDate);
    const preview = await generatePlanPreviewAction(input(asOfDate, proposal.id));
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const confirmed = await confirmPlanVersionAction({
      ...input(asOfDate, proposal.id),
      snapshotId: preview.data.snapshotId,
      previewToken: preview.data.previewToken,
    });
    expect(confirmed.ok, confirmed.ok ? undefined : confirmed.error).toBe(true);
    if (!confirmed.ok) return;

    const activated = await prisma.planProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(activated.status).toBe('ACTIVE');
    expect(activated.activatedAt).not.toBeNull();
    const written = await prisma.planTask.findMany({
      where: { planVersion: confirmed.data.version },
      orderBy: [{ planDate: 'asc' }, { sortOrder: 'asc' }],
    });
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((task) => task.sourceKind === 'MANUAL')).toBe(true);
    expect(written.reduce((sum, task) => sum + task.plannedMinutes, 0)).toBe(55);

    const parsed = written.map((task) => JSON.parse(task.decisionJson ?? '{}'));
    expect(parsed.every((decision) => decision.origin === 'USER_EDIT')).toBe(true);
    expect(parsed.every((decision) => decision.reason.startsWith('USER_EDIT：'))).toBe(true);
    expect(parsed.map((decision) => decision.candidateMeta.diagnosticProposal.evidenceRef))
      .toEqual(expect.arrayContaining([TASK_37.evidenceRef, TASK_18.evidenceRef]));
    expect(written.some((task) => task.note?.includes(TASK_37.title))).toBe(true);
    expect(written.some((task) => task.note?.includes(TASK_37.reason))).toBe(true);
    expect(parsed.map((decision) => decision.candidateMeta.diagnosticProposal.userReason))
      .toEqual(expect.arrayContaining([TASK_37.reason, TASK_18.reason]));
  });

  it('草案修改或已启用后，旧预览确认返回 CONFLICT 且不写计划', async () => {
    const asOfDate = '2026-11-29';
    await setupDate(asOfDate);
    const proposal = await createProposal(asOfDate);
    const preview = await generatePlanPreviewAction(input(asOfDate, proposal.id));
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    await prisma.planProposal.update({
      where: { id: proposal.id },
      data: { tasksJson: tasksJson([{ ...TASK_37, minutes: 40 }]) },
    });
    const before = await prisma.planTask.count();
    const modified = await confirmPlanVersionAction({
      ...input(asOfDate, proposal.id), snapshotId: preview.data.snapshotId, previewToken: preview.data.previewToken,
    });
    expect(modified.ok).toBe(false);
    if (!modified.ok) expect(modified.code).toBe('CONFLICT');
    expect(await prisma.planTask.count()).toBe(before);

    const fresh = await generatePlanPreviewAction(input(asOfDate, proposal.id));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    await prisma.planProposal.update({ where: { id: proposal.id }, data: { status: 'ACTIVE' } });
    const active = await confirmPlanVersionAction({
      ...input(asOfDate, proposal.id), snapshotId: fresh.data.snapshotId, previewToken: fresh.data.previewToken,
    });
    expect(active.ok).toBe(false);
    if (!active.ok) expect(active.code).toBe('CONFLICT');
    expect(await prisma.planTask.count()).toBe(before);
  });

  it('过期、已被取代、非 7D 或零预算无法排入提案时拒绝预览或确认', async () => {
    const asOfDate = '2026-11-30';
    await setupDate(asOfDate, 0);
    const proposal = await createProposal(asOfDate);
    const zero = await generatePlanPreviewAction(input(asOfDate, proposal.id));
    expect(zero.ok).toBe(true);
    if (!zero.ok) return;
    expect(zero.data.proposal?.scheduledTaskCount).toBe(0);
    const zeroConfirm = await confirmPlanVersionAction({
      ...input(asOfDate, proposal.id), snapshotId: zero.data.snapshotId, previewToken: zero.data.previewToken,
    });
    expect(zeroConfirm.ok).toBe(false);
    if (!zeroConfirm.ok) expect(zeroConfirm.code).toBe('PRECONDITION');

    const wider = await generatePlanPreviewAction({ ...input(asOfDate, proposal.id), horizonDays: 30 });
    expect(wider.ok).toBe(false);
    if (!wider.ok) expect(wider.code).toBe('PRECONDITION');

    const stale = await generatePlanPreviewAction(input('2026-12-01', proposal.id));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('PRECONDITION');

    await prisma.placementReport.update({ where: { sessionId: `session-${asOfDate}` }, data: { status: 'SUPERSEDED' } });
    const superseded = await generatePlanPreviewAction(input(asOfDate, proposal.id));
    expect(superseded.ok).toBe(false);
    if (!superseded.ok) expect(superseded.code).toBe('PRECONDITION');
  });

  it('提案只剩无法成块的尾差时拒绝确认，草案保持 DRAFT', async () => {
    const asOfDate = '2026-12-04';
    await setupDate(asOfDate, 9);
    await prisma.dailyBudget.update({
      where: { date: addDays(asOfDate, 6) },
      data: { plannedAvailableMinutes: 0, isRestDay: true, tierCode: 'REST' },
    });
    const proposal = await createProposal(asOfDate);
    const preview = await generatePlanPreviewAction(input(asOfDate, proposal.id));
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.proposal).toMatchObject({
      taskCount: 2,
      scheduledTaskCount: 2,
      totalMinutes: 55,
      scheduledMinutes: 54,
    });
    const confirmed = await confirmPlanVersionAction({
      ...input(asOfDate, proposal.id),
      snapshotId: preview.data.snapshotId,
      previewToken: preview.data.previewToken,
    });
    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) {
      expect(confirmed.code).toBe('PRECONDITION');
      expect(confirmed.error).toContain('还有 1 分钟未排入');
    }
    expect(await prisma.planTask.count()).toBe(0);
    expect((await prisma.planProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('DRAFT');
  });

  it('预览后诊断报告被取代时确认返回 CONFLICT 且不写计划', async () => {
    const asOfDate = '2026-12-05';
    await setupDate(asOfDate, 20);
    const proposal = await createProposal(asOfDate);
    const preview = await generatePlanPreviewAction(input(asOfDate, proposal.id));
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    await prisma.placementReport.update({
      where: { sessionId: `session-${asOfDate}` },
      data: { status: 'SUPERSEDED' },
    });
    const confirmed = await confirmPlanVersionAction({
      ...input(asOfDate, proposal.id),
      snapshotId: preview.data.snapshotId,
      previewToken: preview.data.previewToken,
    });
    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) expect(confirmed.code).toBe('CONFLICT');
    expect(await prisma.planTask.count()).toBe(0);
    expect((await prisma.planProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('DRAFT');
  });
});
