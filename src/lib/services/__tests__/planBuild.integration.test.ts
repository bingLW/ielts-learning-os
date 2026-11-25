/**
 * T07 `buildPlan()` + 确认/版本 action 主证据 —— 验收 ①–⑤。
 *
 * 为什么走真库：`buildPlan` 的被测行为（快照复用、预览零写、确认才建版本、
 * MONTH 层 8 项结构）全部发生在 `buildPlanningSnapshot` 的装配与
 * `confirmPlanVersionAction` 的写库事务里，mock 掉 prisma 等于把被测逻辑一起 mock 掉。
 *
 * 三条写测试的自我约束（`41 §1.9`）：
 * - **A-1**：「预览零写」断言前先确认初始计数；「确认建版本」断言用前后差值而非绝对值。
 * - **A-2**：期望值手抄字面量（layer='MONTH'、8 个键、parentVersionId=null），不从被测函数反查。
 * - **A-3**：每条断言都能说出"哪种错误实现会让它红"：
 *   ① 预览若误写 PlanTask → 计数断言红；② 确认漏 snapshotId → 计数断言红；
 *   ③ 幂等漏判 → CONFLICT 断言红；④ 比例分母写错 → 求和断言红；⑤ 漏 8 项结构 → 键集断言红。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

/**
 * 读集必须写全：`buildPlanningSnapshot` 会跑 8 个候选源 + 缺口 + 评分，
 * 任何一张没清的源表都会让种子数据混进 `decisions`。清空后候选池只剩本文件显式造的。
 */
const { prisma, path } = await createTestDb([
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
const { generatePlanPreviewAction, confirmPlanVersionAction } = await import('@/lib/actions/planner');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-build';

const DAY_INPUT = { purpose: 'GENERATE' as const, asOfDate: AS_OF, horizonDays: 1, stageId: STAGE_ID };

/** ③ 用独立基准日，避免与 ② 的同输入快照复用成同一个 previewToken（会撞幂等键）。 */
const DAY_INPUT_ALT = { purpose: 'GENERATE' as const, asOfDate: '2026-11-26', horizonDays: 1, stageId: STAGE_ID };

/** MONTH 层 8 项结构的键（手抄字面量，`41 §5.2`）。 */
const MONTH_STRUCTURE_KEYS = [
  'stageGoal',
  'weeklyMilestones',
  'skillAllocation',
  'weeklyTests',
  'materialSuggestions',
  'vocabGrammarScope',
  'acceptanceCriteria',
  'adjustmentConditions',
];

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: '构建测试阶段',
      estDaysMin: 30,
      status: 'ACTIVE',
      profileCode: 'B1_B2',
    },
  });
  await prisma.plannerSettings.create({
    data: { id: 1, defaultDailyMinutes: 60, minTaskMinutes: 5, isUserConfirmed: true },
  });
  await prisma.dailyBudget.create({
    data: { date: AS_OF, plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.dailyBudget.create({
    data: { date: '2026-11-26', plannedAvailableMinutes: 60, isRestDay: false, source: 'USER' },
  });
  await prisma.learningGoal.create({
    data: {
      goalType: 'GENERAL_ENGLISH',
      name: '通用英语',
      status: 'ACTIVE',
      targetValue: 'B2',
      targetDate: '2027-01-01',
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(path)) unlinkSync(path);
});

describe('T07 buildPlan（预览零写 + 取舍 + MONTH 结构）', () => {
  it('① 预览 → PlanTask / PlanVersion 行数不变（Q4：预览不落库）', async () => {
    const planTaskBefore = await prisma.planTask.count();
    const planVersionBefore = await prisma.planVersion.count();

    const result = await buildPlan(DAY_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await prisma.planTask.count()).toBe(planTaskBefore);
    expect(await prisma.planVersion.count()).toBe(planVersionBefore);
  });

  it('④ tradeoffs.p0Ratio / coreRatio / extensiveRatio 之和 ≈ 1', async () => {
    const result = await buildPlan(DAY_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { p0Ratio, coreRatio, extensiveRatio } = result.data.tradeoffs;
    // 三比例把「已安排总分钟」完整切分为 P0 / (P1+P2) / P3，之和必须为 1
    expect(Math.abs(p0Ratio + coreRatio + extensiveRatio - 1)).toBeLessThan(1e-9);
  });

  it('② 确认 → 新增 1 条 PlanVersion(snapshotId 非空)', async () => {
    const preview = await generatePlanPreviewAction(DAY_INPUT);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const before = await prisma.planVersion.count({ where: { snapshotId: { not: null } } });

    const confirm = await confirmPlanVersionAction({
      ...DAY_INPUT,
      snapshotId: preview.data.snapshotId,
      previewToken: preview.data.previewToken,
    });
    expect(confirm.ok).toBe(true);
    if (!confirm.ok) return;

    const after = await prisma.planVersion.count({ where: { snapshotId: { not: null } } });
    expect(after - before).toBe(1);

    const header = await prisma.planVersion.findFirst({
      where: { snapshotId: preview.data.snapshotId },
      orderBy: { createdAt: 'desc' },
    });
    expect(header).not.toBeNull();
    expect(header?.snapshotId).toBe(preview.data.snapshotId);
  });

  it('③ 同 previewToken 重复确认 → 第二次 fail(CONFLICT)', async () => {
    const preview = await generatePlanPreviewAction(DAY_INPUT_ALT);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const confirmInput = {
      ...DAY_INPUT_ALT,
      snapshotId: preview.data.snapshotId,
      previewToken: preview.data.previewToken,
    };

    const first = await confirmPlanVersionAction(confirmInput);
    expect(first.ok).toBe(true);

    const second = await confirmPlanVersionAction(confirmInput);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('CONFLICT');
  });

  it('⑤ horizonDays=30 → layer=MONTH 版本 + 8 项结构 + parentVersionId=null（无 CYCLE）', async () => {
    const monthInput = { purpose: 'GENERATE' as const, asOfDate: AS_OF, horizonDays: 30, stageId: STAGE_ID };
    const preview = await generatePlanPreviewAction(monthInput);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.data.layer).toBe('MONTH');
    expect(preview.data.layerStructure).not.toBeNull();
    expect(preview.data.days).toHaveLength(0); // MONTH 只产结构，不排明细任务

    const confirm = await confirmPlanVersionAction({
      ...monthInput,
      snapshotId: preview.data.snapshotId,
      previewToken: preview.data.previewToken,
    });
    expect(confirm.ok).toBe(true);
    if (!confirm.ok) return;

    const version = await prisma.planVersion.findUnique({ where: { id: confirm.data.versionId } });
    expect(version).not.toBeNull();
    expect(version?.layer).toBe('MONTH');
    expect(version?.snapshotId).toBe(preview.data.snapshotId);
    expect(version?.parentVersionId).toBeNull();

    const parsed = JSON.parse(version!.afterSnapshot ?? '{}') as Record<string, unknown>;
    // `layer` 是与 8 项并存的元数据键（`PlanLayerStructure.layer`），8 项必须一个不少
    const keys = Object.keys(parsed);
    for (const key of MONTH_STRUCTURE_KEYS) {
      expect(keys).toContain(key);
    }
    expect(parsed.layer).toBe('MONTH');
    expect(Array.isArray(parsed.weeklyMilestones)).toBe(true);
    expect((parsed.weeklyMilestones as unknown[]).length).toBe(4);

    // 无 CYCLE 时 confirm 应带 warning（`41 §5.4`）
    expect(confirm.data.warnings.length).toBeGreaterThan(0);
    expect(confirm.data.warnings.some((w) => w.includes('无'))).toBe(true);
  });
});
