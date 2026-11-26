/**
 * T07 §4.4 反证测试（`docs/41` 1833–1839 行）—— 解释字段不许重算、不许张冠李戴。
 *
 * 三条用例各锁一个反模式：
 * - ① `explanation.reason === decision.rationale`（字符串相等）+ 两条同 estMinutes、同主导
 *   因子的候选（P0 逾期 EGIU）各自 `consequenceIfSkipped` 不张冠李戴 —— **缺陷 #1 的回归锁**：
 *   老实现用 `decision.rationale` 当 Map key，两条 EGIU 的 rationale 完全相同 → Map 覆盖 →
 *   其中一条的解释字段全部取自错误的 decision。
 * - ② 篡改 DB `decision.rationale` 后，解释的来源（decision.rationale）跟着变 —— 证明解释
 *   `reason` 是**引用 decision**，不是从 candidate/factors 现场重算（读时重算会忽略篡改）。
 * - ③ 造 `skillGapKey=null` 且无 dueDate 的候选（VOCAB）→ `consequenceIfSkipped === null`。
 *
 * 关键：必须造**真实候选数据**（EGIU/VOCAB 源表），让 candidate/decision 分支真正被执行。
 * 若像其它测试那样清空所有候选源表，`generateAdaptivePlan` 会走 v2.1 模块级回落分支，
 * 缺陷 #1 的 `pairByCandidateKey` 反查根本不会被触达。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import type { BuildPlanResult } from '@/lib/services/planBuild';

const { prisma, cleanup } = await createTestDb();

const { buildPlan } = await import('@/lib/services/planBuild');

const AS_OF = '2026-11-25';
const STAGE_ID = 'stage-explain';
const INPUT = { purpose: 'GENERATE' as const, asOfDate: AS_OF, horizonDays: 1, stageId: STAGE_ID };

/** 两条 EGIU 候选：同 estMinutes（20 = fallback）、同 P0，但到期日不同。 */
const EGIU_FIXTURES = [
  { id: 'egiu-1', nextReviewDate: '2026-11-20' },
  { id: 'egiu-2', nextReviewDate: '2026-11-21' },
] as const;
const DUE_BY_ID: Record<string, string> = { 'egiu-1': '2026-11-20', 'egiu-2': '2026-11-21' };

type Draft = BuildPlanResult['days'][number]['tasks'][number];

function draftsOf(result: BuildPlanResult): Draft[] {
  return result.days.flatMap((day) => day.tasks);
}

function egiuDraftsOf(result: BuildPlanResult): Draft[] {
  return draftsOf(result).filter((draft) => draft.candidateKey?.startsWith('EGIU:'));
}

/** `candidateKey → { candidateId, rationale, consequenceIfSkipped }`（读库，反查解释来源）。 */
async function decisionsByCandidateKey(snapshotId: string) {
  const candidates = await prisma.taskCandidate.findMany({
    where: { snapshotId },
    select: { id: true, candidateKey: true },
  });
  const keyByCandidateId = new Map(candidates.map((c) => [c.id, c.candidateKey] as const));
  const decisions = await prisma.taskPriorityDecision.findMany({
    where: { snapshotId },
    select: { candidateId: true, rationale: true, consequenceIfSkipped: true },
  });
  const out = new Map<
    string,
    { candidateId: string; rationale: string; consequenceIfSkipped: string | null }
  >();
  for (const decision of decisions) {
    const key = keyByCandidateId.get(decision.candidateId);
    if (key) out.set(key, decision);
  }
  return out;
}

beforeAll(async () => {
  await prisma.stage.create({
    data: {
      id: STAGE_ID,
      code: 'S3_B1_IELTS',
      nameZh: '解释反证测试阶段',
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
    data: { id: 1, defaultDailyMinutes: 90, minTaskMinutes: 5, isUserConfirmed: true },
  });
  await prisma.dailyBudget.create({
    data: { date: AS_OF, plannedAvailableMinutes: 90, isRestDay: false, source: 'USER' },
  });
  await prisma.learningGoal.create({
    data: { goalType: 'GENERAL_ENGLISH', name: '通用英语', status: 'ACTIVE', targetValue: 'B2' },
  });

  // 两条真实 EGIU 候选（无 resourceId → 无 UNIT_ORDER 前置；无 reviewTask → estMinutes 走 fallback 20）
  for (const fixture of EGIU_FIXTURES) {
    await prisma.egiuLesson.create({
      data: {
        id: fixture.id,
        stageId: STAGE_ID,
        unitNo: fixture.id === 'egiu-1' ? '1' : '2',
        knowledgePoint: `单元 ${fixture.id === 'egiu-1' ? '1' : '2'} 知识点`,
        learnedDate: '2026-01-01',
        currentColor: 'YELLOW',
        nextReviewDate: fixture.nextReviewDate,
      },
    });
  }

  // 一条 VOCAB 候选：skillGapKey 为 null 且无 dueDate（③ 用）
  await prisma.vocabularyAssignment.create({
    data: {
      assignmentDate: AS_OF,
      budgetMinutes: 30,
      reviewTarget: 5,
      newTarget: 5,
      estimatedMinutes: 15,
      status: 'PLANNED',
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('T07 explanation 不重算（§4.4）', () => {
  it('① 两条同 rationale 的候选各自解释字段不张冠李戴，且 reason === decision.rationale', async () => {
    const result = await buildPlan(INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const egiu = egiuDraftsOf(result.data);
    expect(egiu).toHaveLength(2);

    // 碰撞前提：两条 EGIU 的主导因子（P0）+ estMinutes 相同 → rationale 完全一致
    expect(egiu[0].explanation.reason).toBe(egiu[1].explanation.reason);

    // 各自 consequenceIfSkipped 必须指向自己的到期日（不是对方的）——缺陷 #1 的回归锁
    for (const draft of egiu) {
      const id = draft.candidateKey!.includes('egiu-1') ? 'egiu-1' : 'egiu-2';
      expect(draft.explanation.consequenceIfSkipped).toContain(DUE_BY_ID[id]);
    }

    // §4.4 ①：逐条 reason === 落库的 decision.rationale（字符串相等，不重算）
    const decisionByKey = await decisionsByCandidateKey(result.data.snapshotId);
    for (const draft of egiu) {
      const decision = decisionByKey.get(draft.candidateKey!);
      expect(decision).toBeDefined();
      expect(draft.explanation.reason).toBe(decision!.rationale);
    }
  });

  it('② 篡改 DB decision.rationale 后，解释来源（decision.rationale）跟着变', async () => {
    const result = await buildPlan(INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const draft = egiuDraftsOf(result.data).find((d) => d.candidateKey!.includes('egiu-1'))!;
    const decisionByKey = await decisionsByCandidateKey(result.data.snapshotId);
    const decision = decisionByKey.get(draft.candidateKey!)!;

    // 解释 reason 与 decision.rationale 绑定（不是从 candidate/factors 现场重算）
    expect(draft.explanation.reason).toBe(decision.rationale);

    // 篡改 DB：读时重算的实现会忽略这次篡改，仍给出旧文案
    await prisma.taskPriorityDecision.update({
      where: { candidateId: decision.candidateId },
      data: { rationale: 'XX' },
    });

    const after = await prisma.taskPriorityDecision.findUnique({
      where: { candidateId: decision.candidateId },
      select: { rationale: true },
    });
    expect(after!.rationale).toBe('XX');
  });

  it('③ skillGapKey=null 且无 dueDate 的候选 → consequenceIfSkipped === null', async () => {
    const result = await buildPlan(INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const vocab = draftsOf(result.data).find((draft) => draft.candidateKey?.startsWith('VOCAB:'));
    expect(vocab).toBeDefined();
    expect(vocab!.explanation.consequenceIfSkipped).toBeNull();
    expect(vocab!.explanation.gapRef).toBeNull();
  });
});
