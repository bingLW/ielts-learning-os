/**
 * AC-17 ⑤–⑧：AI 建议被调度器拒绝时的语义。
 *
 * - ⑤ 超预算 → 整条拒绝，`eligibility='REJECTED_AI_OVER_BUDGET'`，任务不进 `days`；
 * - ⑥ 池外 key → `REJECTED_NOT_IN_POOL`，**不新建** `TaskCandidate`；
 * - ⑦ 只允许改措辞：`priority`/`factors` 变了 → `REJECTED_AI_MUTATED_DECISION`；
 * - ⑧ 拒绝不按比例裁剪：候选仍保留原分钟数，不产出半截任务。
 *
 * 注入方式与 `aiFallback.test.ts` 相同：spy `OpenAICompatibleProvider.prototype.complete`。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

process.env.AI_PROVIDER_API_KEY ??= 'test-plan-ai-key-123456';
process.env.AI_PROVIDER_BASE_URL ??= 'https://plan.test.invalid/v1';

const { prisma, cleanup } = await createTestDb();

const { buildPlan } = await import('@/lib/services/planBuild');
const { ensurePromptRegistry } = await import('@/lib/ai/registry');
const { OpenAICompatibleProvider } = await import('@/lib/ai/provider');
const { assertReasonOnlyChanged } = await import('@/lib/domain/taskPriority');
type TaskPriorityDecisionDraft = import('@/lib/domain/taskPriority').TaskPriorityDecisionDraft;

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-ai-reject';

/** 两条到期复习：5 分钟（放得下）/ 60 分钟（放不下）。 */
const RV_SHORT = 'rv-short';
const RV_LONG = 'rv-long';
const KEY_SHORT = `REVIEW:review:${RV_SHORT}:VOCAB_REVIEW`;
const KEY_LONG = `REVIEW:review:${RV_LONG}:VOCAB_REVIEW`;
const KEY_GHOST = 'REVIEW:review:never-existed:VOCAB_REVIEW';

const completeSpy = vi.spyOn(OpenAICompatibleProvider.prototype, 'complete');

function completionOk(json: unknown) {
  return { ok: true as const, rawText: JSON.stringify(json), json, inputTokens: 10, outputTokens: 10, latencyMs: 1 };
}

function keysOf(block: string | undefined): string[] {
  return [...(block ?? '').matchAll(/(?:^|\n)\s*-\s*key=([^|\n]+)/g)].map((m) => m[1].trim());
}

/** picks 走 suggest、其余（explain）回显真实 key —— 让 AI 层进入 `on` 而不是校验失败。 */
function mockPicks(keys: string[]) {
  completeSpy.mockImplementation(async (request) => {
    if (request.kind === 'plan_suggest_candidates') {
      return completionOk({
        picks: keys.map((key, index) => ({ candidate_key: key, why: `AI 建议 ${index + 1}`, suggested_order: index + 1 })),
      });
    }
    return completionOk({
      tasks: keysOf(request.meta.planDayBlock).map((key) => ({ candidate_key: key, reason: '润色后的理由' })),
    });
  });
}

function draftOf(patch: Partial<TaskPriorityDecisionDraft>): TaskPriorityDecisionDraft {
  return {
    candidateKey: KEY_SHORT,
    weightsVersion: 'v1',
    factors: {
      urgency: 0.4,
      goalRelevance: 0.5,
      evidenceStrength: 0.3,
      errorRecurrence: 0,
      prerequisiteReady: 1,
      timeCost: 1,
      preferenceFit: 0.5,
    },
    score: 0.5,
    priority: 'P0',
    rationale: '模板理由',
    consequenceIfSkipped: null,
    eligibility: 'ELIGIBLE',
    blockedReason: null,
    meta: { estMinutesSource: 'SOURCE', skillGapKey: null, evidenceRefs: [], noObservation: false },
    ...patch,
  };
}

async function snapshotState(snapshotId: string) {
  const candidates = await prisma.taskCandidate.findMany({
    where: { snapshotId },
    select: { id: true, candidateKey: true, estMinutes: true, isAiSuggested: true, aiCallLogId: true },
  });
  const decisions = await prisma.taskPriorityDecision.findMany({
    where: { snapshotId },
    select: { candidateId: true, eligibility: true, blockedReason: true },
  });
  const byId = new Map(decisions.map((row) => [row.candidateId, row]));
  return candidates.map((candidate) => ({ ...candidate, decision: byId.get(candidate.id) ?? null }));
}

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: 'AI 拒绝测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'B1_B2',
    },
  });
  await prisma.skillAllocationProfile.create({
    data: {
      profileCode: 'B1_B2',
      listeningPct: 25,
      readingPct: 25,
      speakingPct: 25,
      writingPct: 25,
      effectiveFrom: '2026-01-01',
      isActive: true,
    },
  });
  await prisma.plannerSettings.create({
    data: { id: 1, defaultDailyMinutes: 60, minTaskMinutes: 5, isUserConfirmed: true },
  });
  await prisma.dailyBudget.create({
    data: { date: AS_OF, plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.learningGoal.create({
    data: { goalType: 'GENERAL_ENGLISH', name: '通用英语', status: 'ACTIVE', targetValue: 'B2' },
  });
  await prisma.aIEngineSetting.create({
    data: {
      id: 'default',
      externalAiEnabled: true,
      dailyBudgetUsd: 1,
      monthlyBudgetUsd: 20,
      warnPercent: 80,
      directTeachingDefault: false,
      explainLanguage: 'ZH_MIXED',
    },
  });
  await prisma.learnerProfile.create({
    data: { id: 'default', externalAiConsent: true },
  });
  await prisma.reviewTask.createMany({
    data: [
      {
        id: RV_SHORT,
        targetType: 'VOCAB_WORD',
        targetId: 'word-short',
        targetLabel: 'short-review',
        intervalCode: 'D1',
        dueDate: AS_OF,
        status: 'PENDING',
        estMinutes: 5,
      },
      {
        id: RV_LONG,
        targetType: 'VOCAB_WORD',
        targetId: 'word-long',
        targetLabel: 'long-review',
        intervalCode: 'D1',
        dueDate: AS_OF,
        status: 'PENDING',
        estMinutes: 60,
      },
    ],
  });
  await ensurePromptRegistry(prisma);
});

afterAll(async () => {
  completeSpy.mockRestore();
  await prisma.$disconnect();
  cleanup();
});

describe('AC-17 ⑤⑧ AI 建议超预算 → 整条拒绝（不裁剪）', () => {
  it('⑤ 20 分钟预算 + 60 分钟候选 → 不进 days + REJECTED_AI_OVER_BUDGET', async () => {
    mockPicks([KEY_LONG]);
    const result = await buildPlan({
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 1,
      stageId: STAGE_ID,
      allowAi: true,
      budgetOverrideMinutes: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.aiMode).toBe('on');
    const tasks = result.data.days.flatMap((day) => day.tasks);
    expect(tasks.some((task) => task.candidateKey === KEY_LONG)).toBe(false);

    const overBudget = result.data.rejectedAiSuggestions.filter((row) => row.reason.startsWith('OVER_BUDGET'));
    expect(overBudget.length).toBe(1);
    expect(overBudget[0].aiCallLogId).not.toBeNull();

    const rows = await snapshotState(result.data.snapshotId);
    const long = rows.find((row) => row.candidateKey === KEY_LONG);
    expect(long).toBeTruthy();
    expect(long?.decision?.eligibility).toBe('REJECTED_AI_OVER_BUDGET');
    expect(long?.isAiSuggested).toBe(false);
  });

  it('⑧ 被拒绝的候选保留原分钟数，不产出半截任务', async () => {
    mockPicks([KEY_LONG]);
    const result = await buildPlan({
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 1,
      stageId: STAGE_ID,
      allowAi: true,
      budgetOverrideMinutes: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await snapshotState(result.data.snapshotId);
    const long = rows.find((row) => row.candidateKey === KEY_LONG);
    expect(long?.estMinutes).toBe(60);

    // 没有任何命中了 long-review 的任务行（若按 20/60 裁剪，会留下一条 5~15 分钟的同名任务）
    const tasks = result.data.days.flatMap((day) => day.tasks);
    expect(tasks.filter((task) => task.candidateKey === KEY_LONG)).toHaveLength(0);
    // 同一快照里短复习确实排进去了 → 上面的空断言不是"整天没任务"造成的
    expect(tasks.some((task) => task.candidateKey === KEY_SHORT)).toBe(true);
  });
});

describe('AC-17 ⑥ 池外建议 → REJECTED_NOT_IN_POOL，不新建候选', () => {
  it('⑥ AI 返回不存在的 key → 记录拒绝 + 池内无该候选行', async () => {
    mockPicks([KEY_GHOST]);
    const result = await buildPlan({
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 1,
      stageId: STAGE_ID,
      allowAi: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.aiMode).toBe('on');
    const ghost = result.data.rejectedAiSuggestions.filter((row) => row.reason.includes('REJECTED_NOT_IN_POOL'));
    expect(ghost.length).toBe(1);

    const rows = await snapshotState(result.data.snapshotId);
    expect(rows.some((row) => row.candidateKey === KEY_GHOST)).toBe(false);
  });
});

describe('AC-17 ⑦ 只允许改措辞（结构化比对）', () => {
  it('只改 rationale → 通过', () => {
    const before = draftOf({});
    const after = draftOf({ rationale: 'AI 润色后的理由' });
    expect(assertReasonOnlyChanged(before, after)).toEqual({ ok: true });
  });

  it('改 priority → REJECTED_AI_MUTATED_DECISION（字段名点名 priority）', () => {
    const before = draftOf({});
    const after = draftOf({ priority: 'P1' });
    const check = assertReasonOnlyChanged(before, after);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe('REJECTED_AI_MUTATED_DECISION');
    expect(check.fields).toContain('priority');
  });

  it('改 factors / score / eligibility 同样被拦', () => {
    const before = draftOf({});
    const afterFactors = draftOf({ factors: { ...before.factors, timeCost: 0.03 } });
    const afterEligibility = draftOf({ eligibility: 'BLOCKED_PREREQUISITE' });
    const factorsCheck = assertReasonOnlyChanged(before, afterFactors);
    const eligibilityCheck = assertReasonOnlyChanged(before, afterEligibility);
    expect(factorsCheck.ok).toBe(false);
    expect(eligibilityCheck.ok).toBe(false);
    if (!factorsCheck.ok) expect(factorsCheck.fields).toContain('factors');
    if (!eligibilityCheck.ok) expect(eligibilityCheck.fields).toContain('eligibility');
  });
});