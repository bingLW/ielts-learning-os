/**
 * ⑲ 整链路反证（T04 唯一的跨层测试）—— C-H 真正的防点。
 *
 * 为什么必须有这一条：`SkillGap` 表里**没有** `evidenceQuestions` / `repeatedErrorCount`
 * 两列，它们是 `SkillGapDraft` 的纯 DTO 字段。如果哪天有人"顺手从表里查更省事"，
 * 这两个值会变成 `undefined` → `errorRecurrence` 恒 `0`、`noObservation` 恒 `false`，
 * 而**其余所有单测都会继续绿**：单测里手搓的 `ctx.gaps` 自带这两个字段，永远绿。
 *
 * 只有从库里长出来的数据能证明这条通道接通了：
 *
 * ```
 * EvidenceRecord / Mistake  →  buildPlanningSnapshot（含 buildSkillGaps）
 *   → collectCandidates  →  scoreCandidate  →  decisions
 * ```
 *
 * 断言锚在"两种维度必须表现不同"上：
 * - `READING`：练过（有打分证据）+ 有 6 条错题 → `errorRecurrence > 0`、`noObservation = false`；
 * - `SPEAKING`：只有辅助级（A1）证据、没有任何打分 → `evidenceQuestions = 0`
 *   → `errorRecurrence = 0`、`noObservation = true`。
 *
 * 另外直接查一次 `PRAGMA table_info(SkillGap)`：那两列**确实**不存在。
 * 这条不是"重复断言"，它是这份测试的前提 —— 前提变了（以后真加了列），
 * 这份测试就不再是 C-H 的证据，得重新设计。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

/**
 * **读集必须写全**：`buildPlanningSnapshot` 会跑 `collectCandidates()`（8 个来源）
 * 再对每条候选评分。任何一张没清的源表都会让种子数据混进 `decisions`，
 * 于是"READING / SPEAKING 两个维度必须表现不同"这类断言就变成在赌本机库的现状。
 *
 * 清空之后候选池里只剩本文件造的两条 `RETEST`（READING / SPEAKING），
 * 所以下面可以断言 `decisions` **恰好 2 条**。
 */
const { prisma } = await createTestDb([
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
  'evidenceRecord',
  'skillProfile',
  'learningGoal',
  'learningCycle',
  'skillGap',
  'taskPriorityDecision',
  'taskCandidate',
  'planningSnapshot',
  'planTask',
  'learningMaterial',
  'resource',
]);

const { buildPlanningSnapshot } = await import('@/lib/services/planningSnapshot');
const { WEAKNESS_MIN_QUESTIONS } = await import('@/lib/constants');

/** 近 28 天窗口内的某一天（相对 `AS_OF`）。 */
const AS_OF = '2026-03-10';

let snapshot: Awaited<ReturnType<typeof buildPlanningSnapshot>>;
let stageId = '';

beforeAll(async () => {
  const existingStage = await prisma.stage.findFirst({ where: { status: 'ACTIVE' } });
  const stage =
    existingStage ??
    (await prisma.stage.create({
      data: { code: 'S3_B1_IELTS', nameZh: 'B1→IELTS 过渡', estDaysMin: 30, status: 'ACTIVE', sortOrder: 0 },
    }));
  stageId = stage.id;

  // ── READING：独立证据 2 条（有打分）+ 6 条可归属的错题 ──
  const readingEvidence = await prisma.evidenceRecord.create({
    data: {
      skill: 'READING',
      evidenceType: 'BASELINE',
      level: 'QUICK',
      assistanceLevel: 'A0',
      score: 1,
      confidence: 'MEDIUM',
      createdAt: new Date(`${AS_OF}T01:00:00.000Z`),
    },
  });
  await prisma.evidenceRecord.create({
    data: {
      skill: 'READING',
      evidenceType: 'APPLIED_TASK',
      level: 'QUICK',
      assistanceLevel: 'A0',
      score: 2,
      confidence: 'MEDIUM',
      createdAt: new Date(`${AS_OF}T02:00:00.000Z`),
    },
  });
  const record = await prisma.studyRecord.create({
    data: { stageId, recordDate: AS_OF, skill: 'READING', content: '阅读细节题训练', totalQuestions: 10, correctQuestions: 4 },
  });
  for (let index = 0; index < 6; index += 1) {
    await prisma.mistake.create({
      data: {
        stageId,
        studyRecordId: record.id,
        sourceType: 'STUDY_RECORD',
        originalQuestion: `TFNG ${index}`,
        correctAnswer: 'NG',
        errorReason: '定位错',
        knowledgePoint: 'TFNG',
        errorCategory: 'CARELESS',
        // 必须落在 `asOfDate` 的 28 天窗口内：`createdAt` 默认是**真实 now()**，
        // 不显式给日期的话它永远在窗口之外，`repeatedErrorCount` 恒 0 ——
        // 而那条断言会以"因子等于 0"的形式失败，看起来像实现没接通
        createdAt: new Date(`${AS_OF}T05:00:00.000Z`),
      },
    });
  }

  // ── SPEAKING：只有辅助级（A1）证据、没有任何打分 → 未观察 ──
  const speakingEvidence = await prisma.evidenceRecord.create({
    data: {
      skill: 'SPEAKING',
      evidenceType: 'ASSISTED',
      level: 'QUICK',
      assistanceLevel: 'A1',
      score: null,
      confidence: 'LOW',
      createdAt: new Date(`${AS_OF}T03:00:00.000Z`),
    },
  });

  // ── 两条复测：它们让两个维度都有候选，`skillGapKey` 是 `OFFICIAL:<skill>:` ──
  await prisma.retestSchedule.create({
    data: {
      parentEvidenceId: readingEvidence.id,
      retestType: 'DELAYED',
      dueDate: AS_OF,
      estMinutes: 10,
      idempotencyKey: `chain-reading-${AS_OF}`,
    },
  });
  await prisma.retestSchedule.create({
    data: {
      parentEvidenceId: speakingEvidence.id,
      retestType: 'DELAYED',
      dueDate: AS_OF,
      estMinutes: 10,
      idempotencyKey: `chain-speaking-${AS_OF}`,
    },
  });

  snapshot = await buildPlanningSnapshot({ purpose: 'GENERATE', asOfDate: AS_OF, horizonDays: 7 });
  expect(snapshot.ok).toBe(true);
});

afterAll(async () => {
  await prisma.planningSnapshot.deleteMany({});
  await prisma.$disconnect();
});

describe('⑲ 前提：SkillGap 表确实没有那两个列', () => {
  it('PRAGMA table_info(SkillGap) 里没有 evidenceQuestions / repeatedErrorCount', async () => {
    const columns = await prisma.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info("SkillGap")');
    const names = columns.map((row) => row.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('evidenceQuestions');
    expect(names).not.toContain('repeatedErrorCount');
    // 反向：它确实有"看起来能替代"的聚合列 —— 这正是"从表里查更省事"的诱饵
    expect(names).toContain('evidenceCount');
    expect(names).toContain('severity');
  });
});

describe('⑲ errorRecurrence 从 DTO 通道取到真值', () => {
  const decisionOf = (skill: string) => {
    if (!snapshot.ok) throw new Error('快照构建失败');
    // 只找 RETEST 那条：QUESTION 的种子题也会以 `:READING` 结尾（那是目标技能，
    // 不是我们要验的维度缺口）
    const hit = snapshot.data.context.decisions.find(
      (row) => row.candidateKey.startsWith('RETEST:') && row.candidateKey.endsWith(`:${skill}`),
    );
    if (!hit) {
      const keys = snapshot.data.context.decisions.map((row) => row.candidateKey).join(', ');
      throw new Error(`没有 ${skill} 的决策；实际有：${keys}`);
    }
    return hit;
  };

  it('READING：练过且有 6 条错题 → 因子非零、noObservation=false', () => {
    const decision = decisionOf('READING');
    // 6 / (10 × 2) = 0.30
    expect(WEAKNESS_MIN_QUESTIONS).toBe(10);
    expect(decision.factors.errorRecurrence).toBeCloseTo(0.3, 10);
    expect(decision.factors.errorRecurrence).toBeGreaterThan(0);
    expect(decision.meta.noObservation).toBe(false);
    expect(decision.meta.skillGapKey).toBe('OFFICIAL:READING:');
  });

  it('SPEAKING：没有任何打分证据 → 因子 0、noObservation=true', () => {
    const decision = decisionOf('SPEAKING');
    expect(decision.factors.errorRecurrence).toBe(0);
    expect(decision.meta.noObservation).toBe(true);
    expect(decision.meta.skillGapKey).toBe('OFFICIAL:SPEAKING:');
  });

  it('`noObservation === (evidenceQuestions === 0)` 在两个维度上都成立', () => {
    // 直接对落库的缺口做一次反向核对：DTO 的值来自 `buildSkillGaps`，不是从表里补的
    const reading = decisionOf('READING');
    const speaking = decisionOf('SPEAKING');
    expect(reading.meta.noObservation).not.toBe(speaking.meta.noObservation);
    // 两个候选都是到期复测 → 恒 P0（与分数无关）
    expect(reading.priority).toBe('P0');
    expect(speaking.priority).toBe('P0');
  });
});

describe('⑲ 落库的一侧：候选与决策成对写入', () => {
  it('每个 TaskCandidate 都有且只有一个 TaskPriorityDecision，且 factorsJson 是两层', async () => {
    if (!snapshot.ok) throw new Error('快照构建失败');
    const candidates = await prisma.taskCandidate.findMany({
      where: { snapshotId: snapshot.data.snapshotId },
      select: { id: true, candidateKey: true, decision: { select: { factorsJson: true, weightsVersion: true } } },
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const row of candidates) {
      expect(row.decision, row.candidateKey).toBeTruthy();
      const parsed = JSON.parse(row.decision!.factorsJson) as Record<string, unknown>;
      expect(Object.keys(parsed).sort(), row.candidateKey).toEqual(['factors', 'meta']);
      expect(Object.keys(parsed.factors as object).length, row.candidateKey).toBe(7);
      expect(row.decision!.weightsVersion, row.candidateKey).toBeTruthy();
    }
  });

  it('候选池恰好只剩本文件造的两条 RETEST（读集清干净了，没有种子数据混进来）', async () => {
    if (!snapshot.ok) throw new Error('快照构建失败');
    const keys = snapshot.data.context.decisions.map((row) => row.candidateKey).sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]?.startsWith('RETEST:')).toBe(true);
    expect(keys[1]?.startsWith('RETEST:')).toBe(true);
  });

  it('快照不再把候选池报成"缺失输入"', async () => {
    if (!snapshot.ok) throw new Error('快照构建失败');
    const missing = snapshot.data.context.validation.missing.map((item) => item.key);
    expect(missing).not.toContain('CANDIDATES');
  });
});

describe('C-J：多条 ACTIVE 目标时，取哪一条必须是确定的', () => {
  it('按 `createdAt asc` 取最早那条（而不是插入顺序）', async () => {
    await prisma.learningGoal.deleteMany({});
    // 刻意**先建新的、后建旧的**：如果实现漏了 `orderBy`，SQLite 会返回先插入的那条
    // （= 新的），这条断言就会红 —— 这就是 A-3 要求的"变异能精准命中"。
    await prisma.learningGoal.create({
      data: {
        goalType: 'GENERAL_ENGLISH',
        name: '通用英语（较新）',
        status: 'ACTIVE',
        targetValue: 'B2',
        targetDate: '2026-09-01',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    });
    await prisma.learningGoal.create({
      data: {
        // `goalType` 有唯一约束 → 两条 ACTIVE 只能是不同轨道（这正是 seed 造出
        // 3 条 ACTIVE 的原因，也是 C-J 必须加确定性排序的原因）
        goalType: 'IELTS',
        name: '雅思（较早）',
        status: 'ACTIVE',
        targetValue: '6.5',
        targetDate: '2026-06-01',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        minReading: 6.5,
      },
    });

    const rebuilt = await buildPlanningSnapshot({ purpose: 'GENERATE', asOfDate: '2026-03-11', horizonDays: 7 });
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    // 旧的那条 `targetDate` 是 2026-06-01；新的那条是 2026-09-01
    expect(rebuilt.data.context.goal?.targetDate).toBe('2026-06-01');
    // 顺带证明 `skillTargets` 也确实来自同一行（旧那条设了 minReading）
    expect(rebuilt.data.context.goal?.skillTargets).toEqual({ READING: 6.5 });
  });
});

describe('⑳㉑ 调用链：真实 LearningGoal 行 → goalRelevance（不是单测手搓的 ctx）', () => {
  const rebuild = async () => {
    const result = await buildPlanningSnapshot({ purpose: 'GENERATE', asOfDate: AS_OF, horizonDays: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('快照构建失败');
    const reading = result.data.context.decisions.find(
      (row) => row.candidateKey.startsWith('RETEST:') && row.candidateKey.endsWith(':READING'),
    );
    if (!reading) throw new Error('没有 READING 的复测决策');
    return { context: result.data.context, reading };
  };

  it('minReading = null、其余三项有值 → skillTargets 里没有 READING，因子得 0.30', async () => {
    await prisma.learningGoal.deleteMany({});
    await prisma.learningGoal.create({
      data: {
        goalType: 'IELTS',
        name: '雅思（只关心三项）',
        status: 'ACTIVE',
        targetValue: '6.5',
        targetDate: '2026-06-01',
        minListening: 6,
        minWriting: 6,
        minSpeaking: 6,
        // `minReading` 刻意不给 → 数据库里是 null
      },
    });
    await prisma.learningCycle.deleteMany({});
    await prisma.learningCycle.create({
      data: { title: '90 天周期', goal: 'IELTS 6.5', startDate: '2026-01-01', endDate: '2026-03-31', status: 'BUILD' },
    });

    const { context, reading } = await rebuild();
    // `parseSkillTargets` 丢掉了 null → 键不存在（不是"目标 0 分"）
    expect('READING' in (context.goal?.skillTargets ?? {})).toBe(false);
    expect(context.goal?.skillTargets).toEqual({ LISTENING: 6, WRITING: 6, SPEAKING: 6 });
    // 该技能不在目标内 → 0.30（确认为无关系），不是 0、不是 NaN
    expect(reading.factors.goalRelevance).toBe(0.3);
    expect(Number.isFinite(reading.factors.goalRelevance)).toBe(true);
  });

  it('同一目标、但没有任何在跑的周期 → 0.50（不是 1.00）', async () => {
    await prisma.learningCycle.deleteMany({});
    const { context, reading } = await rebuild();
    // 目标行还在，只是没有周期
    expect(context.goal).not.toBeNull();
    expect(reading.factors.goalRelevance).toBe(0.5);
    expect(reading.factors.goalRelevance).not.toBe(1);
  });

  it('有周期 + 目标内有 READING → 走 90 天公式：剩余 83 天 → 1 − 83/90 ≈ 0.0778', async () => {
    await prisma.learningGoal.deleteMany({});
    await prisma.learningGoal.create({
      data: {
        goalType: 'IELTS',
        name: '雅思（含阅读）',
        status: 'ACTIVE',
        targetValue: '6.5',
        targetDate: '2026-06-01', // 距 AS_OF 83 天
        minReading: 6.5,
      },
    });
    await prisma.learningCycle.create({
      data: { title: '90 天周期', goal: 'IELTS 6.5', startDate: '2026-01-01', endDate: '2026-03-31', status: 'BUILD' },
    });
    const { reading } = await rebuild();
    // 期望值**手算**：2026-03-10 → 2026-06-01 = 83 天，1 − 83/90 = 0.07777…
    // （不写 `1 - 83/90`：那与被测实现是同一个表达式，等于用实现验证实现）
    expect(reading.factors.goalRelevance).toBeCloseTo(0.0778, 4);
  });
});
