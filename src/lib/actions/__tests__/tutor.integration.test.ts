/**
 * AI Coach 服务端闭环集成测试（独立临时数据库）。
 *
 * Server Action 的 revalidatePath 需要 Next 请求上下文，这里显式 mock 掉，
 * 其余逻辑（校验、状态机、证据写入、幂等、预算拦截）走真实实现。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

process.env.AI_CREDENTIALS_SECRET ??= 'ielts-integration-test-secret';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const { prisma, cleanup } = await createTestDb();
const actions = await import('@/lib/actions/tutor');
const { getAiSessionDetail, getAiAdminData } = await import('@/lib/queries/tutor');
const { ensurePromptRegistry } = await import('@/lib/ai/registry');
const { runAiTurn } = await import('@/lib/ai/orchestrator');
const { AI_ASSESSMENT_DISCLAIMER_ZH } = await import('@/lib/constants');

const baselineText = 'Last year I go to the beach with my family. We are very happy.';

beforeAll(async () => {
  // 诊断转错题必须显式依赖一个 ACTIVE 阶段，不能继承本机开发库状态。
  await prisma.stage.create({
    data: {
      code: 'S3_B1_IELTS',
      nameZh: 'AI Coach 集成测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      sortOrder: 0,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('AI Learning Coach 闭环', () => {
  it('Prompt Registry 追加式且幂等', async () => {
    const first = await ensurePromptRegistry(prisma);
    const versions = await prisma.promptVersion.count();
    const second = await ensurePromptRegistry(prisma);
    expect(await prisma.promptVersion.count()).toBe(versions);
    for (const kind of Object.keys(first) as Array<keyof typeof first>) {
      expect(second[kind].versionId).toBe(first[kind].versionId);
    }
  });

  it('完整教学流程：任务 → 基线 → 诊断 → 提示 → 讲解 → 练习 → 复测 → 排期', async () => {
    const sessionBefore = await prisma.aILearningSession.count();
    const start = await actions.startAiSessionAction({
      mode: 'TUTOR',
      skill: 'WRITING',
      objective: '用 5 句话描述一次难忘的旅行',
      targetLevel: 'B1',
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const sessionId = start.data.sessionId;
    expect(start.data.taskReady).toBe(true);
    expect(start.data.providerMode).toBe('mock');
    expect(await prisma.aILearningSession.count()).toBe(sessionBefore + 1);

    const created = await prisma.aILearningSession.findUnique({
      where: { id: sessionId },
      include: { turns: true, tasks: true },
    });
    expect(created?.status).toBe('TASK_PRESENTED');
    expect(created?.turns.some((turn) => turn.kind === 'TASK' && turn.role === 'AI')).toBe(true);
    expect(created?.tasks).toHaveLength(1);
    expect(created?.provider).toBe('mock');

    // ── 基线前必须先拒绝诊断/提示 ────────────────────────────────────
    const earlyDiagnosis = await actions.requestDiagnosisAction({
      sessionId,
      clientRequestId: 'it-early-diagnosis',
    });
    expect(earlyDiagnosis.ok).toBe(false);
    if (!earlyDiagnosis.ok) expect(earlyDiagnosis.code).toBe('PRECONDITION');

    const earlyHint = await actions.requestHintAction({
      sessionId,
      clientRequestId: 'it-early-hint',
      level: 1,
    });
    expect(earlyHint.ok).toBe(false);

    // ── 基线只写一次，重复请求同 ID 返回同一轮次 ─────────────────────
    const baseline = await actions.submitBaselineAction({
      sessionId,
      text: baselineText,
      clientRequestId: 'it-baseline-0001',
    });
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    const baselineRetry = await actions.submitBaselineAction({
      sessionId,
      text: '另一个答案',
      clientRequestId: 'it-baseline-0001',
    });
    expect(baselineRetry.ok).toBe(true);
    if (baselineRetry.ok) expect(baselineRetry.data.turnId).toBe(baseline.data.turnId);

    const secondBaseline = await actions.submitBaselineAction({
      sessionId,
      text: '覆盖尝试',
      clientRequestId: 'it-baseline-0002',
    });
    expect(secondBaseline.ok).toBe(false);
    if (!secondBaseline.ok) expect(secondBaseline.code).toBe('CONFLICT');

    const baselineEvidence = await prisma.evidenceRecord.findUnique({
      where: { id: baseline.data.evidenceId },
    });
    expect(baselineEvidence?.assistanceLevel).toBe('A0');
    expect(baselineEvidence?.assessorType).toBe('SELF');
    expect(baselineEvidence?.outputText).toBe(baselineText);

    // ── 诊断 ───────────────────────────────────────────────────────
    const diagnosis = await actions.requestDiagnosisAction({
      sessionId,
      clientRequestId: 'it-diagnosis-0001',
    });
    expect(diagnosis.ok).toBe(true);
    if (!diagnosis.ok) return;
    expect(diagnosis.data.text).toContain('【诊断】');
    expect(diagnosis.data.diagnosis.observed_evidence.length).toBeGreaterThan(0);

    // ── 提示只能逐级，且 1–2 级不泄题 ──────────────────────────────
    const jump = await actions.requestHintAction({
      sessionId,
      clientRequestId: 'it-hint-jump-0001',
      level: 3,
    });
    expect(jump.ok).toBe(false);

    const hint1 = await actions.requestHintAction({
      sessionId,
      clientRequestId: 'it-hint-0001',
      level: 1,
    });
    expect(hint1.ok).toBe(true);
    if (hint1.ok) expect(hint1.data.hint.reveals_answer).toBe(false);

    const hint2 = await actions.requestHintAction({
      sessionId,
      clientRequestId: 'it-hint-0002',
      level: 2,
    });
    expect(hint2.ok).toBe(true);
    if (hint2.ok) expect(hint2.data.hint.reveals_answer).toBe(false);

    // ── 讲解与练习 ─────────────────────────────────────────────────
    const teaching = await actions.requestTeachingAction({
      sessionId,
      clientRequestId: 'it-teaching-0001',
    });
    expect(teaching.ok).toBe(true);

    const drill = await actions.generateDrillAction({
      sessionId,
      clientRequestId: 'it-drill-0001',
    });
    expect(drill.ok).toBe(true);
    if (!drill.ok) return;

    // 提交前，页面查询不得把练习答案带到客户端。
    const detail = await getAiSessionDetail(sessionId);
    const drillTurn = detail?.turns.find((turn) => turn.kind === 'DRILL');
    expect(JSON.stringify(drillTurn?.structured)).not.toContain('（参考：');
    expect(detail?.session).not.toHaveProperty('turns');

    // 用户原始答案始终未被覆盖。
    const afterAi = await prisma.aILearningSession.findUnique({ where: { id: sessionId } });
    expect(afterAi?.baselineText).toBe(baselineText);

    // ── 即时复测：写入 AI 证据并完成基线排期 ───────────────────────
    const retest = await actions.submitImmediateRetestAction({
      sessionId,
      text: 'Last summer I visited a small town near the sea with my parents.',
      aidLevel: 'none',
      clientRequestId: 'it-retest-0001',
    });
    expect(retest.ok).toBe(true);
    if (!retest.ok) return;
    expect(retest.data.assessment.is_official_score).toBe(false);
    expect(retest.data.score).toBeGreaterThanOrEqual(0);
    expect(retest.data.score).toBeLessThanOrEqual(2);

    const retestEvidence = await prisma.evidenceRecord.findUnique({
      where: { id: retest.data.evidenceId },
    });
    expect(retestEvidence?.assessorType).toBe('AI');
    expect(retestEvidence?.assistanceLevel).toBe('A0');
    expect(retestEvidence?.note).toContain(AI_ASSESSMENT_DISCLAIMER_ZH);

    const rootId = baselineEvidence?.chainRootId ?? baselineEvidence?.id;
    const pendingImmediate = await prisma.retestSchedule.count({
      where: { parentEvidenceId: rootId, retestType: 'IMMEDIATE', status: 'PENDING' },
    });
    expect(pendingImmediate).toBe(0);
    const doneImmediate = await prisma.retestSchedule.findFirst({
      where: {
        parentEvidenceId: rootId,
        retestType: 'IMMEDIATE',
        status: 'DONE',
        completedEvidenceId: retest.data.evidenceId,
      },
    });
    expect(doneImmediate).not.toBeNull();

    // 同一复测 ID 重放不重复写证据。
    const retestEvidenceCount = await prisma.evidenceRecord.count({
      where: { aiSessionId: sessionId, evidenceType: 'IMMEDIATE_RETEST' },
    });
    const retestReplay = await actions.submitImmediateRetestAction({
      sessionId,
      text: '重复提交',
      aidLevel: 'none',
      clientRequestId: 'it-retest-0001',
    });
    expect(retestReplay.ok).toBe(true);
    if (retestReplay.ok) expect(retestReplay.data.evidenceId).toBe(retest.data.evidenceId);
    expect(
      await prisma.evidenceRecord.count({
        where: { aiSessionId: sessionId, evidenceType: 'IMMEDIATE_RETEST' },
      }),
    ).toBe(retestEvidenceCount);

    // 完成后提示可展开，验证练习答案是受状态控制的。
    const completedDetail = await getAiSessionDetail(sessionId);
    const completedDrill = completedDetail?.turns.find((turn) => turn.kind === 'DRILL');
    expect(JSON.stringify(completedDrill?.structured)).toContain('参考');

    // ── 延迟复测排期 ───────────────────────────────────────────────
    const delayed = await actions.scheduleDelayedRetestAction({ sessionId });
    expect(delayed.ok).toBe(true);
    if (delayed.ok) {
      expect(delayed.data.scheduled).toBeGreaterThan(0);
      expect(delayed.data.rootEvidenceId).toBe(rootId);
    }
    const finalSession = await prisma.aILearningSession.findUnique({ where: { id: sessionId } });
    expect(finalSession?.status).toBe('DELAYED_RETEST_SCHEDULED');

    // ── 用户反馈 ───────────────────────────────────────────────────
    const diagnosisTurn = await prisma.aILearningTurn.findFirst({
      where: { sessionId, kind: 'DIAGNOSIS' },
      orderBy: { sequence: 'asc' },
    });
    const feedback = await actions.markTurnFeedbackAction({
      sessionId,
      turnId: diagnosisTurn?.id ?? '',
      helpfulness: 'HELPFUL',
      note: '引用清楚，能照着改。',
    });
    expect(feedback.ok).toBe(true);
    expect(await prisma.aISessionFeedback.count({ where: { sessionId } })).toBe(1);

    // ── 诊断转错题：显式确认后才写入错题本 ─────────────────────────
    const mistakesBefore = await prisma.mistake.count();
    const promoted = await actions.promoteDiagnosisToMistakeAction({
      sessionId,
      knowledgePoint: '一般过去时',
      originalQuestion: 'E2E v2.4：用 5 句话描述旅行',
      myAnswer: baselineText,
      correctAnswer: 'Last year I went to the beach with my family. We were very happy.',
      errorReason: '动词时态前后不一致。',
    });
    expect(promoted.ok).toBe(true);
    expect(await prisma.mistake.count()).toBe(mistakesBefore + 1);

    // ── 删除 AI 会话不删除证据 ─────────────────────────────────────
    const evidenceIds = [baseline.data.evidenceId, retest.data.evidenceId];
    const deleted = await actions.deleteAiSessionAction({ sessionId });
    expect(deleted.ok).toBe(true);
    expect(await prisma.aILearningSession.findUnique({ where: { id: sessionId } })).toBeNull();
    const surviving = await prisma.evidenceRecord.findMany({
      where: { id: { in: evidenceIds } },
    });
    expect(surviving).toHaveLength(2);
    expect(surviving.every((item) => item.aiSessionId === null)).toBe(true);
    expect(
      await prisma.retestSchedule.count({ where: { parentEvidenceId: rootId, status: 'PENDING' } }),
    ).toBeGreaterThan(0);
  });

  it('正预算已用满时拦截调用并留下 BLOCKED 日志（mock 零预算豁免）', async () => {
    const session = await prisma.aILearningSession.create({
      data: {
        mode: 'TUTOR',
        skill: 'WRITING',
        objective: '预算测试会话',
        targetLevel: 'B1',
        status: 'TASK_PRESENTED',
        promptTemplateKey: 'ai.task.v1',
        provider: 'mock',
        model: 'mock-deterministic',
        baselineText: 'I am ready.',
      },
    });

    await actions.updateAiEngineSettingsAction({
      externalAiEnabled: false,
      dailyBudgetUsd: 0.01,
      monthlyBudgetUsd: 0.01,
      warnPercent: 80,
      directTeachingDefault: false,
      explainLanguage: 'ZH_MIXED',
    });
    await prisma.aICallLog.create({
      data: {
        sessionId: session.id,
        provider: 'mock',
        model: 'mock-deterministic',
        requestId: `it-cost-${Date.now()}`,
        latencyMs: 1,
        estimatedCostUsd: 0.01,
        status: 'OK',
      },
    });

    const blocked = await runAiTurn({
      prisma,
      sessionId: session.id,
      promptKind: 'teaching',
      turnKind: 'TEACHING',
      clientRequestId: `it-blocked-${Date.now()}`,
      meta: {
        mode: 'TUTOR',
        skill: 'WRITING',
        objective: '预算测试',
        targetLevel: 'B1',
        baseline: 'I am ready.',
      },
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('BUDGET_EXCEEDED');
    expect(
      await prisma.aICallLog.count({ where: { sessionId: session.id, status: 'BLOCKED' } }),
    ).toBe(1);
    expect(
      await prisma.aILearningTurn.count({ where: { sessionId: session.id, kind: 'TEACHING' } }),
    ).toBe(0);

    await actions.updateAiEngineSettingsAction({
      externalAiEnabled: false,
      dailyBudgetUsd: 1,
      monthlyBudgetUsd: 20,
      warnPercent: 80,
      directTeachingDefault: false,
      explainLanguage: 'ZH_MIXED',
    });
    await actions.deleteAiSessionAction({ sessionId: session.id });
  });

  it('Provider 凭据：加密入库、只回显末四位、清除后回落', async () => {
    const saved = await actions.saveProviderCredentialAction({
      baseUrl: 'https://api.example.com/v1',
      modelName: 'model-x',
      apiKey: 'sk-integration-1234567890',
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.data.apiKeyConfigured).toBe(true);
      expect(saved.data.apiKeyLast4).toBe('7890');
    }

    const row = await prisma.aIProviderCredential.findUnique({ where: { id: 'default' } });
    expect(row?.apiKeyCipher).toBeTruthy();
    expect(row?.apiKeyCipher).not.toContain('sk-integration');
    expect(row?.apiKeyLast4).toBe('7890');
    expect(row?.baseUrl).toBe('https://api.example.com/v1');
    expect(row?.modelName).toBe('model-x');

    const admin = await getAiAdminData();
    expect(admin.credential.source).toBe('database');
    expect(admin.credential.apiKeyConfigured).toBe(true);
    expect(admin.credential.apiKeyLast4).toBe('7890');
    expect(admin.credential.modelName).toBe('model-x');
    expect(admin.credential.decryptionFailed).toBe(false);

    const cleared = await actions.saveProviderCredentialAction({
      baseUrl: 'https://api.example.com/v1',
      modelName: 'model-x',
      clearApiKey: true,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.data.apiKeyConfigured).toBe(false);

    const after = await prisma.aIProviderCredential.findUnique({ where: { id: 'default' } });
    expect(after?.apiKeyCipher).toBeNull();
    expect(after?.apiKeyLast4).toBeNull();
  });
});