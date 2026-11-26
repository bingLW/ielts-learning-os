/**
 * AC-17 ⑨–⑪：`byAi` 的唯一赋值点与失败/拒绝时的取值。
 *
 * - ⑨ `aiMode='failed'` → 结果与库中 `isAiSuggested` 全为 false；
 * - ⑩ AI 开、但某条建议被拒 → 该任务 `byAi=false`（只有"被采纳 **且** 已排入"才为 true）；
 * - ⑪ 文本扫描：`planBuild.ts` 里 `byAi` 只有一处赋值（`41 §6.5`）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
const STAGE_ID = 'stage-byai';

const RV_SHORT = 'rv-short';
const RV_LONG = 'rv-long';
const KEY_SHORT = `REVIEW:review:${RV_SHORT}:VOCAB_REVIEW`;
const KEY_LONG = `REVIEW:review:${RV_LONG}:VOCAB_REVIEW`;

const completeSpy = vi.spyOn(OpenAICompatibleProvider.prototype, 'complete');

function completionOk(json: unknown) {
  return { ok: true as const, rawText: JSON.stringify(json), json, inputTokens: 10, outputTokens: 10, latencyMs: 1 };
}

function keysOf(block: string | undefined): string[] {
  return [...(block ?? '').matchAll(/(?:^|\n)\s*-\s*key=([^|\n]+)/g)].map((m) => m[1].trim());
}

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

async function candidateRows(snapshotId: string) {
  return prisma.taskCandidate.findMany({
    where: { snapshotId },
    select: { id: true, candidateKey: true, isAiSuggested: true, aiCallLogId: true },
  });
}

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: 'byAi 测试阶段',
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
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(path)) unlinkSync(path);
});

describe('AC-17 ⑨ failed → 全 byAi=false（结果 + 库）', () => {
  it('⑨ provider 失败 → 结果内 byAi 全 false，库中 isAiSuggested 全 false', async () => {
    completeSpy.mockReset();
    completeSpy.mockResolvedValue({
      ok: false as const,
      code: 'PROVIDER_ERROR',
      message: 'provider down',
      latencyMs: 1,
      inputTokens: 0,
      outputTokens: 0,
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

    const tasks = result.data.days.flatMap((day) => day.tasks);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((task) => task.byAi === false)).toBe(true);
    expect(tasks.every((task) => task.aiCallLogId === null)).toBe(true);

    const rows = await candidateRows(result.data.snapshotId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.isAiSuggested === false)).toBe(true);
  });
});

describe('AC-17 ⑩ 已采纳但未排入 / 被拒的任务 byAi=false', () => {
  it('⑩ AI 挑 5 分钟与 60 分钟两条 → 只有真正排入的那条 byAi=true', async () => {
    mockPicks([KEY_SHORT, KEY_LONG]);
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
    const short = tasks.find((task) => task.candidateKey === KEY_SHORT);
    expect(short).toBeTruthy();
    expect(short?.byAi).toBe(true);
    // 措辞被润色 ≠ 该任务被 AI 挑中（两个标记独立）
    expect(short?.explanation.wordingSource).toBe('AI_POLISHED');

    // 60 分钟候选放不下 → 不进 days；其余任务（未入选/池外）一律 byAi=false
    expect(tasks.some((task) => task.candidateKey === KEY_LONG)).toBe(false);
    for (const task of tasks) {
      if (task.candidateKey !== KEY_SHORT) expect(task.byAi).toBe(false);
    }

    const rows = await candidateRows(result.data.snapshotId);
    const shortRow = rows.find((row) => row.candidateKey === KEY_SHORT);
    const longRow = rows.find((row) => row.candidateKey === KEY_LONG);
    expect(shortRow?.isAiSuggested).toBe(true);
    expect(shortRow?.aiCallLogId).not.toBeNull();
    expect(longRow?.isAiSuggested).toBe(false);

    const longDecision = await prisma.taskPriorityDecision.findFirst({
      where: { snapshotId: result.data.snapshotId, candidateId: longRow?.id ?? '' },
      select: { eligibility: true, blockedReason: true },
    });
    expect(longDecision?.eligibility).toBe('REJECTED_AI_OVER_BUDGET');
    expect(longDecision?.blockedReason ?? '').toContain('OVER_BUDGET');
  });
});

describe('AC-17 ⑪ byAi 赋值点唯一（文本扫描）', () => {
  it('⑪ planBuild.ts 中 byAi 只有一处赋值，且四条件同时成立', () => {
    const file = fileURLToPath(new URL('../services/planBuild.ts', import.meta.url));
    const source = readFileSync(file, 'utf8');

    // 行尾 `byAi:` 即赋值；接口声明写作 `byAi: boolean;`，不计入
    const assignments = source.match(/^\s*byAi:\s*$/gm) ?? [];
    expect(assignments).toHaveLength(1);
    // 不允许另起一处 `byAi = …` / `byAi ??=` / `byAi ||=` 之类赋值
    expect(source.match(/\bbyAi\s*(?:[+\-*/%]|\|\||&&|\?\?)?=(?!=)/g) ?? []).toHaveLength(0);

    const block = source.slice(source.indexOf('byAi:'));
    expect(block).toContain("ai.mode === 'on'");
    expect(block).toContain('isAiSuggested === true');
    expect(block).toContain("eligibility === 'ELIGIBLE'");
    expect(block).toContain('ai.picks.has(key)');
  });
});