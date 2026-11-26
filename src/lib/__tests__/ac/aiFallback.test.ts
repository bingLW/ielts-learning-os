/**
 * AC-17：AI 关闭与失败时，规则计划照常返回（T07 ⑫ + T14 ①–④）。
 *
 * - ④ `allowAi=false` → `ok:true`、`aiMode='off'`、**所有** `byAi=false`、**零次** provider 调用；
 * - ① provider 抛错 / ② 超时 → `ok:true`、`aiMode='failed'`、全部 `byAi=false`、`aiNote` 含错误码；
 * - ③ 返回非法 JSON → `INVALID_OUTPUT` → `failed`（提示词未发布也算 PRECONDITION，不阻断）。
 *
 * 用 `vi.spyOn(OpenAICompatibleProvider.prototype, 'complete')` 注入可控返回：
 * 不改模块图，也不发真实网络请求。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

process.env.AI_PROVIDER_API_KEY ??= 'test-plan-ai-key-123456';
process.env.AI_PROVIDER_BASE_URL ??= 'https://plan.test.invalid/v1';

const { prisma, path } = await createTestDb([
  'aICallLog',
  'promptVersion',
  'promptTemplate',
  'aIEngineSetting',
  'aIProviderCredential',
  'aIModelConfig',
  'exerciseAttempt',
  'diagnosticAttempt',
  'generatedExercise',
  'diagnosticItem',
  'diagnosticBlueprint',
  'materialPackItem',
  'materialPack',
  'taskProposalItem',
  'taskProposal',
  'vocabularyAssignmentItem',
  'vocabularyAssignment',
  'reviewTask',
  'retestSchedule',
  'egiuReview',
  'egiuLesson',
  'listeningExercise',
  'speakingPrompt',
  'transcript',
  'audioAsset',
  'contentChunk',
  'parsedDocument',
  'materialExerciseSet',
  'mistake',
  'studyRecord',
  'studySessionDaySplit',
  'evidenceRecord',
  'studySession',
  'skillProfile',
  'goalMilestone',
  'learningGoal',
  'weeklyFocus',
  'learningCycle',
  'taskPriorityDecision',
  'taskCandidate',
  'skillGap',
  'planningSnapshot',
  'planTask',
  'planVersion',
  'dailyBudget',
  'weeklyDayAllocation',
  'weeklyTarget',
  'plannerSettings',
  'skillAllocationProfile',
  'stageAcceptanceItem',
  'stage',
  'learningMaterial',
  'resource',
]);

const { buildPlan } = await import('@/lib/services/planBuild');
const { ensurePromptRegistry } = await import('@/lib/ai/registry');
const { OpenAICompatibleProvider } = await import('@/lib/ai/provider');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-ai';

const completeSpy = vi.spyOn(OpenAICompatibleProvider.prototype, 'complete');

function completionOk(json: unknown) {
  const rawText = JSON.stringify(json);
  return {
    ok: true as const,
    rawText,
    json,
    inputTokens: 10,
    outputTokens: 10,
    latencyMs: 1,
  };
}

function completionFailure(code: 'TIMEOUT' | 'NETWORK' | 'PROVIDER_ERROR', message: string) {
  return {
    ok: false as const,
    code,
    message,
    latencyMs: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** 从 `planDayBlock` 里取 key（fake provider 的 explain 需要回显真实 key）。 */
function keysOf(block: string | undefined): string[] {
  return [...(block ?? '').matchAll(/(?:^|\n)\s*-\s*key=([^|\n]+)/g)].map((m) => m[1].trim());
}

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: 'AI 桩测试阶段',
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
  await ensurePromptRegistry(prisma);
});

afterAll(async () => {
  completeSpy.mockRestore();
  await prisma.$disconnect();
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(path)) unlinkSync(path);
});

describe('T07 aiMode=off 回退（④）', () => {
  it('④ allowAi=false → ok + off + 全部 byAi=false + 零次 provider 调用', async () => {
    completeSpy.mockClear();
    const result = await buildPlan({
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 1,
      stageId: STAGE_ID,
      allowAi: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.aiMode).toBe('off');
    expect(typeof result.data.aiNote).toBe('string');
    expect((result.data.aiNote as string).length).toBeGreaterThan(0);
    expect(completeSpy).not.toHaveBeenCalled();

    const tasks = result.data.days.flatMap((day) => day.tasks);
    // 关掉 AI 时规则路径必须产出任务（否则"全部 byAi=false"退化成空断言）
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.byAi).toBe(false);
      expect(task.aiCallLogId).toBeNull();
      expect(task.explanation.wordingSource).toBe('TEMPLATE');
    }
  });
});

describe('T14 aiMode=failed 回退（①–③）', () => {
  it('① provider 抛错 → ok + failed + 全 byAi=false + aiNote 含 PROVIDER_ERROR', async () => {
    completeSpy.mockReset();
    completeSpy.mockResolvedValue(completionFailure('PROVIDER_ERROR', 'provider down'));
    const result = await buildPlan({
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 1,
      stageId: STAGE_ID,
      allowAi: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.aiMode).toBe('failed');
    expect(result.data.aiNote).toContain('PROVIDER_ERROR');
    for (const task of result.data.days.flatMap((day) => day.tasks)) {
      expect(task.byAi).toBe(false);
      expect(task.explanation.wordingSource).toBe('TEMPLATE');
    }
  });

  it('② 超时 → ok + failed + aiNote 含 TIMEOUT', async () => {
    completeSpy.mockReset();
    completeSpy.mockResolvedValue(completionFailure('TIMEOUT', '请求超时'));
    const result = await buildPlan({
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 1,
      stageId: STAGE_ID,
      allowAi: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.aiMode).toBe('failed');
    expect(result.data.aiNote).toContain('TIMEOUT');
    for (const task of result.data.days.flatMap((day) => day.tasks)) {
      expect(task.byAi).toBe(false);
    }
  });

  it('③ 非法 JSON（schema 不过）→ INVALID_OUTPUT → failed', async () => {
    completeSpy.mockReset();
    completeSpy.mockImplementation(async (request) => {
      if (request.kind === 'plan_suggest_candidates') {
        return completionOk({ picks: [{ candidate_key: 'only-key' }] });
      }
      return completionOk({ tasks: keysOf(request.meta.planDayBlock).map((key) => ({ candidate_key: key, reason: '润色' })) });
    });
    const result = await buildPlan({
      purpose: 'GENERATE',
      asOfDate: AS_OF,
      horizonDays: 1,
      stageId: STAGE_ID,
      allowAi: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.aiMode).toBe('failed');
    expect(result.data.aiNote).toContain('INVALID_OUTPUT');
    for (const task of result.data.days.flatMap((day) => day.tasks)) {
      expect(task.byAi).toBe(false);
      expect(task.explanation.wordingSource).toBe('TEMPLATE');
    }
  });
});
