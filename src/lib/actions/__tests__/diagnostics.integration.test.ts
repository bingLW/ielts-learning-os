/**
 * v2.4.1 诊断闭环集成测试（真实数据库副本）。
 *
 * 覆盖：分时段暂停/恢复、自适应路由、技术无效不计分、客观题判分、
 * 开放任务待评估、报告暂定、计划草案激活不建 PlanTask、补测与隐私删除。
 */

import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const sourceDb = join(process.cwd(), 'prisma', 'dev.db');
const workDb = join(tmpdir(), `ielts-diagnostic-integration-${process.pid}-${Date.now()}.db`);

if (!existsSync(sourceDb)) throw new Error(`找不到数据库：${sourceDb}`);
copyFileSync(sourceDb, workDb);
process.env.DATABASE_URL = `file:${workDb}`;

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const { prisma } = await import('@/lib/prisma');
const actions = await import('@/lib/actions/diagnostics');
const { getDiagnosticSessionDetail, getDiagnosticReport } = await import('@/lib/queries/diagnostics');

const ANSWERS: Record<string, string> = {
  'L-KEY-A1': 'B',
  'L-DETAIL-A2': 'B',
  'L-GIST-B1': 'B',
  'L-INFER-B2': 'B',
  'R-SIGN-A1': 'A',
  'R-DETAIL-A2': 'B',
  'R-GIST-B1': 'B',
  'R-REFERENCE-B2': 'B',
  'G-BE-A1': 'A',
  'G-PERFECT-A2': 'C',
  'G-RELATIVE-B1': 'B',
  'G-CONDITIONAL-B2': 'B',
  'V-CONTEXT-A2': 'B',
  'V-COLLOC-B1': 'B',
  'V-FORM-B1': 'growth',
  'S-MAIN-A2': 'C',
  'S-COMPLEX-B2': 'B',
};

const OPEN_ANSWER =
  'I usually get up at seven in the morning and have a simple breakfast with my family. In the afternoon I study English for about one hour, and in the evening I take a short walk before going to bed.';

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(workDb, { force: true });
  rmSync(`${workDb}-journal`, { force: true });
});

describe('v2.4.1 初始诊断闭环', () => {
  it('完成多时段诊断、报告、计划确认、补测与删除', async () => {
    const evidenceBefore = await prisma.evidenceRecord.count();
    const taskBefore = await prisma.planTask.count();

    const start = await actions.startDiagnosticAction({
      includeEmlr: false,
      goals: ['GENERAL', 'IELTS'],
      background: {
        examType: 'ACADEMIC',
        weeklyMinutes: 300,
        recordingConsent: true,
        externalAiConsent: false,
        selfWeakness: '听力最弱',
      },
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const sessionId = start.data.sessionId;

    const detail = await getDiagnosticSessionDetail(sessionId);
    expect(detail?.status).toBe('IN_PROGRESS');
    expect(detail?.currentItem?.itemCode).toBe('L-DETAIL-A2');
    expect(detail?.currentItem?.transcript).toContain('main hall');

    // 第一题答对：自适应插入更难平行题
    const first = await actions.submitAttemptAction({
      sessionId,
      itemId: detail!.currentItem!.id,
      responseText: 'B',
      timeSpentSec: 20,
      clientRequestId: 'diag-first',
    });
    expect(first.ok).toBe(true);
    const afterFirst = await getDiagnosticSessionDetail(sessionId);
    expect(afterFirst?.currentItem?.itemCode).toBe('L-GIST-B1');
    expect(afterFirst?.routing[0]?.rationale).toContain('答对');

    // 幂等：相同 clientRequestId 不重复落库
    const attemptsBefore = await prisma.diagnosticAttempt.count({ where: { sessionId } });
    const duplicate = await actions.submitAttemptAction({
      sessionId,
      itemId: detail!.currentItem!.id,
      responseText: 'B',
      timeSpentSec: 20,
      clientRequestId: 'diag-first',
    });
    expect(duplicate.ok).toBe(true);
    expect(await prisma.diagnosticAttempt.count({ where: { sessionId } })).toBe(attemptsBefore);

    // 暂停后拒绝提交，恢复后继续
    const paused = await actions.pauseDiagnosticAction({ sessionId, paused: true });
    expect(paused.ok).toBe(true);
    const blocked = await actions.submitAttemptAction({
      sessionId,
      itemId: afterFirst!.currentItem!.id,
      responseText: 'B',
    });
    expect(blocked.ok).toBe(false);
    const resumed = await actions.pauseDiagnosticAction({ sessionId, paused: false });
    expect(resumed.ok).toBe(true);

    let invalidDone = false;
    for (let step = 0; step < 30; step += 1) {
      const state = await getDiagnosticSessionDetail(sessionId);
      const item = state?.currentItem;
      if (!item) break;

      // 口语发声任务第一次模拟设备失败
      if (item.itemCode === 'SP-PROD-A2' && !invalidDone) {
        invalidDone = true;
        const invalid = await actions.submitAttemptAction({
          sessionId,
          itemId: item.id,
          responseText: '',
          technicalFailed: true,
          technicalReason: '测试：麦克风失败',
          clientRequestId: `invalid-${step}`,
        });
        expect(invalid.ok).toBe(true);
        if (invalid.ok) expect(invalid.data.status).toBe('INVALID');
        continue;
      }

      const text = ANSWERS[item.itemCode] ?? OPEN_ANSWER;
      const result = await actions.submitAttemptAction({
        sessionId,
        itemId: item.id,
        responseText: text,
        timeSpentSec: 30,
        clientRequestId: `step-${step}`,
      });
      expect(result.ok).toBe(true);
    }

    expect(invalidDone).toBe(true);

    const attempts = await prisma.diagnosticAttempt.findMany({ where: { sessionId } });
    const invalidAttempts = attempts.filter((attempt) => attempt.status === 'INVALID');
    expect(invalidAttempts).toHaveLength(1);
    expect(invalidAttempts[0].evidenceId).toBeNull();
    expect(invalidAttempts[0].score).toBeNull();

    // 技术无效的题目被重新排队并最终补做成功
    const speakingProd = attempts.filter((attempt) => attempt.itemId === invalidAttempts[0].itemId);
    expect(speakingProd.length).toBe(2);
    expect(speakingProd.some((attempt) => attempt.status === 'NEEDS_REVIEW')).toBe(true);

    // 每个客观技能最多 2 题（基础题 + 自适应平行题），不会连锁加题
    const scoredWithSkill = await prisma.diagnosticAttempt.findMany({
      where: { sessionId, status: { not: 'INVALID' } },
      select: { item: { select: { skill: true } } },
    });
    const skillCounts = new Map<string, number>();
    for (const row of scoredWithSkill) {
      skillCounts.set(row.item.skill, (skillCounts.get(row.item.skill) ?? 0) + 1);
    }
    for (const skill of ['LISTENING', 'READING', 'GRAMMAR', 'VOCABULARY', 'SENTENCE_STRUCTURE']) {
      expect(skillCounts.get(skill) ?? 0).toBeLessThanOrEqual(2);
    }

    // 开放任务在未启用外部 AI 时保持待评估，不用模拟结果定级
    const pending = attempts.filter((attempt) => attempt.status === 'NEEDS_REVIEW');
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(await prisma.assessmentResult.count({ where: { attempt: { sessionId } } })).toBe(0);

    const finalize = await actions.finalizeDiagnosticAction({ sessionId });
    expect(finalize.ok).toBe(true);
    if (!finalize.ok) return;
    const reportId = finalize.data.reportId;
    expect(finalize.data.provisional).toBe(true);

    const report = await getDiagnosticReport(reportId);
    expect(report?.status).toBe('PROVISIONAL');
    expect(report?.summary).toContain('不取平均');
    expect(report?.snapshots.map((snapshot) => snapshot.skill)).toEqual(
      expect.arrayContaining(['LISTENING', 'READING', 'SPEAKING', 'WRITING', 'GRAMMAR', 'VOCABULARY', 'SENTENCE_STRUCTURE']),
    );

    // 技术无效不作为能力不足证据：听力/阅读已有有效证据
    const listening = report?.snapshots.find((snapshot) => snapshot.skill === 'LISTENING');
    const reading = report?.snapshots.find((snapshot) => snapshot.skill === 'READING');
    expect(listening?.evidenceCount).toBeGreaterThan(0);
    expect(reading?.evidenceCount).toBeGreaterThan(0);
    const speaking = report?.snapshots.find((snapshot) => snapshot.skill === 'SPEAKING');
    expect(speaking?.evidenceCount).toBe(0);
    expect(speaking?.needsFollowUp).toBe(true);

    // 计划草案默认 DRAFT，确认后 ACTIVE，且不自动创建 PlanTask
    expect(report?.proposal?.status).toBe('DRAFT');
    expect(report?.proposal?.budget?.weeklyMinutes).toBeGreaterThan(0);
    const activate = await actions.activatePlanAction({ proposalId: report!.proposal!.id });
    expect(activate.ok).toBe(true);
    const proposal = await prisma.planProposal.findUnique({ where: { id: report!.proposal!.id } });
    expect(proposal?.status).toBe('ACTIVE');
    expect(await prisma.planTask.count()).toBe(taskBefore);

    // 证据确实增加（仅有效尝试），且与 attempt 一对一
    expect(await prisma.evidenceRecord.count()).toBeGreaterThan(evidenceBefore);
    const linked = await prisma.diagnosticAttempt.count({ where: { sessionId, evidenceId: { not: null } } });
    expect(linked).toBeGreaterThan(0);

    // 补测创建新会话，旧报告保留
    const retest = await actions.retestAction({ reportId });
    expect(retest.ok).toBe(true);
    expect(await prisma.placementReport.findUnique({ where: { id: reportId } })).not.toBeNull();

    // 隐私删除：删除会话同时移除其证据与原始作答
    const evidenceIds = (
      await prisma.diagnosticAttempt.findMany({
        where: { sessionId },
        select: { evidenceId: true },
      })
    )
      .map((row) => row.evidenceId)
      .filter((id): id is string => Boolean(id));

    const deleted = await actions.deleteDiagnosticSessionAction({ sessionId });
    expect(deleted.ok).toBe(true);
    expect(await prisma.diagnosticSession.findUnique({ where: { id: sessionId } })).toBeNull();
    if (evidenceIds.length > 0) {
      expect(
        await prisma.evidenceRecord.count({ where: { id: { in: evidenceIds } } }),
      ).toBe(0);
    }
  });
});