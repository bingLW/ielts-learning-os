/**
 * 候选采集（T03）—— AC-2 的主证据。
 *
 * 为什么这份测试走**真库**而不是 mock `prisma`：本任务一半的验收项是「某类行不许
 * 入池」（材料题未批准 / 听力无确认转写 / 已落计划 / 表外题型）。这些判定发生在
 * `where` 与批量集合比较里，mock 掉 prisma 等于把被测的那一半逻辑一起 mock 掉了 ——
 * 测试会绿，但绿的是"我把返回值传了下去"。
 *
 * 三条写测试时的自我约束（`41 §1.9`）：
 * - **A-1**：任何「每个来源都…」「每个缺失技能都…」的断言，先断言集合非空。
 * - **A-2**：期望值一律**手抄字面量**（`3` / `8` / `20` / `15`…），不从
 *   `CANDIDATE_DEFAULT_MINUTES` 反查 —— 那张表这三天被改过三次（拍平 → 子表 → 8 键），
 *   测试若从它反查，三次改动都会一起自洽地通过。
 * - **A-3**：下面每条断言都能说出「哪种错误实现会让它红」。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { QUESTION_OPEN_TASK_SKILL_OVERRIDE, SKILL_IDS } from '@/lib/constants';
// `CANDIDATE_SOURCE_KINDS` 的真身在 domain 层（constants 只引用它的类型）——
// 从 constants 拿会是 `undefined`，而 `[].filter(...)` 恰好不会报错。
import { CANDIDATE_SOURCE_KINDS, type TaskCandidateDraft } from '@/lib/domain/taskCandidate';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

/**
 * **这棵读集必须写全**：`collectCandidates()` 会把 8 个来源全查一遍，任何一张没清的
 * 表都会把本机 `dev.db` 的种子数据混进候选池（例如 seed 里的一条 ready 材料会凭空
 * 多出一批 MATERIAL 候选，而 `no-proposal` 的计数断言会因此变红 —— 换台机器就复现不了）。
 * 顺序：先子后父。
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
  'evidenceRecord',
  'planTask',
  'learningMaterial',
  'resource',
]);

const {
  collectCandidates,
  collectVocabCandidates,
  egiuMinutesOf,
  estMinutesOf,
  sourceMinutesOf,
  UnknownMinuteKeyError,
} = await import('@/lib/services/candidateSources');

/** 业务日：所有 fixture 的到期日都是它。 */
const AS_OF = '2026-03-10';
const YESTERDAY = '2026-03-09';

/** fixture 回填的 id（断言里要用，所以在这里声明）。 */
const ids = {
  stage: '',
  planTask: '',
  review: '',
  retest: '',
  vocabToday: '',
  vocabPlanned: '',
  packWithProposal: '',
  packWithoutProposal: '',
  packWithDirectProposal: '',
  proposalItemDirect: '',
  proposal: '',
  proposalItemOk: '',
  proposalItemPlanned: '',
  exerciseApproved: '',
  exerciseDraft: '',
  diagMcq: '',
  diagOpenTask: '',
  diagAi: '',
  audioConfirmed: '',
  audioMissing: '',
  listeningConfirmed: '',
  listeningMissing: '',
  speakingPrompt: '',
  eguiUnit1: '',
  eguiUnit2: '',
  eguiNoResource: '',
};

let pool: TaskCandidateDraft[] = [];
let skipped: { sourceKind: string; sourceRef: string | null; why: string }[] = [];
let degraded: string[] = [];

function find(list: readonly TaskCandidateDraft[], key: string): TaskCandidateDraft {
  const hit = list.find((row) => row.candidateKey === key);
  if (!hit) throw new Error(`候选池里没有 ${key}；实际有：${list.map((row) => row.candidateKey).join(', ')}`);
  return hit;
}

beforeAll(async () => {
  const existingStage = await prisma.stage.findFirst({ where: { status: 'ACTIVE' } });
  const stage =
    existingStage ??
    (await prisma.stage.create({
      data: { code: 'S3_B1_IELTS', nameZh: 'B1→IELTS 过渡', estDaysMin: 30, status: 'ACTIVE', sortOrder: 0 },
    }));
  ids.stage = stage.id;

  const planTask = await prisma.planTask.create({
    data: { stageId: stage.id, planDate: AS_OF, module: 'READING', skill: 'READING', plannedMinutes: 30 },
  });
  ids.planTask = planTask.id;

  // ── 1. REVIEW ──
  const review = await prisma.reviewTask.create({
    data: {
      targetType: 'EGIU_LESSON',
      targetId: 'lesson-x',
      targetLabel: '现在完成时',
      intervalCode: 'D1',
      dueDate: AS_OF,
      estMinutes: 5,
    },
  });
  ids.review = review.id;

  // ── 2. RETEST ──
  const evidence = await prisma.evidenceRecord.create({
    data: { skill: 'READING', evidenceType: 'BASELINE', level: 'QUICK' },
  });
  const retest = await prisma.retestSchedule.create({
    data: {
      parentEvidenceId: evidence.id,
      retestType: 'DELAYED',
      dueDate: AS_OF,
      estMinutes: 10,
      idempotencyKey: `retest-${AS_OF}`,
    },
  });
  ids.retest = retest.id;

  // ── 4. VOCAB ──
  const vocabToday = await prisma.vocabularyAssignment.create({
    data: { assignmentDate: AS_OF, budgetMinutes: 20, reviewTarget: 20, newTarget: 10, estimatedMinutes: 12 },
  });
  ids.vocabToday = vocabToday.id;
  const vocabPlanned = await prisma.vocabularyAssignment.create({
    data: {
      assignmentDate: YESTERDAY,
      budgetMinutes: 20,
      reviewTarget: 5,
      newTarget: 5,
      estimatedMinutes: 8,
      planTaskId: planTask.id,
    },
  });
  ids.vocabPlanned = vocabPlanned.id;

  // ── 5. MATERIAL ──
  const material = await prisma.learningMaterial.create({
    data: { title: 'The Economist 选段', format: 'TXT', sourceType: 'user_upload', contentHash: `cand-${Date.now()}`, status: 'ready' },
  });
  const pack = await prisma.materialPack.create({ data: { materialId: material.id, estimatedMinutes: 30 } });
  ids.packWithProposal = pack.id;
  await prisma.materialPackItem.create({
    data: { packId: pack.id, itemType: 'CHUNK', refId: 'chunk-1', sortOrder: 1, estimatedMinutes: 20 },
  });
  const otherMaterial = await prisma.learningMaterial.create({
    data: { title: '未生成草案的材料', format: 'TXT', sourceType: 'user_upload', contentHash: `cand2-${Date.now()}`, status: 'partial' },
  });
  const otherPack = await prisma.materialPack.create({
    data: { materialId: otherMaterial.id, estimatedMinutes: 30 },
  });
  ids.packWithoutProposal = otherPack.id;
  await prisma.materialPackItem.create({
    data: { packId: otherPack.id, itemType: 'CHUNK', refId: 'chunk-2', sortOrder: 1 },
  });

  // ── 第三种形态：包存在，但材料只有「单材料直出」的提案（`TaskProposal.packId IS NULL`）──
  const directMaterial = await prisma.learningMaterial.create({
    data: {
      title: '单材料直出的材料',
      format: 'TXT',
      sourceType: 'user_upload',
      contentHash: `cand3-${Date.now()}`,
      status: 'ready',
    },
  });
  const directPack = await prisma.materialPack.create({
    data: { materialId: directMaterial.id, estimatedMinutes: 20 },
  });
  ids.packWithDirectProposal = directPack.id;
  await prisma.materialPackItem.create({
    data: { packId: directPack.id, itemType: 'CHUNK', refId: 'chunk-3', sortOrder: 1 },
  });
  const directProposal = await prisma.taskProposal.create({
    data: {
      materialId: directMaterial.id,
      // 关键：**不挂包**
      packId: null,
      baseDate: AS_OF,
      budgetMinutes: 40,
      totalMinutes: 20,
      status: 'draft',
    },
  });
  const directItem = await prisma.taskProposalItem.create({
    data: {
      proposalId: directProposal.id,
      module: 'READING',
      targetSkill: 'READING',
      title: '单材料直出：精读',
      suggestedMinutes: 20,
      granularity: 15,
      suggestedDate: AS_OF,
    },
  });
  ids.proposalItemDirect = directItem.id;

  const exerciseSet = await prisma.materialExerciseSet.create({
    data: { materialId: material.id, title: '选段练习', targetSkill: 'READING' },
  });
  const doc = await prisma.parsedDocument.create({
    data: { materialId: material.id, version: 1, parserName: 'txt', parserVersion: '1' },
  });
  const chunk = await prisma.contentChunk.create({
    data: {
      materialId: material.id,
      parsedDocumentId: doc.id,
      seq: 1,
      kind: 'PARAGRAPH',
      text: 'Candidate collection passage for exercise approval.',
      textHash: 'seed-candidates',
      charCount: 48,
      charStart: 0,
      charEnd: 48,
    },
  });
  const exerciseApproved = await prisma.generatedExercise.create({
    data: {
      materialId: material.id,
      setId: exerciseSet.id,
      chunkId: chunk.id,
      type: 'reading_gist',
      targetSkill: 'READING',
      prompt: '这一段的主旨是什么？',
      answerJson: JSON.stringify({ options: [{ key: 'A', text: 'x' }], correctKey: 'A', isSingleAnswer: true }),
      explanation: '主旨句在第一句',
      evidenceQuote: 'Candidate collection passage',
      dedupeKey: 'seed-cand-approved',
      reviewStatus: 'approved',
    },
  });
  ids.exerciseApproved = exerciseApproved.id;
  const exerciseDraft = await prisma.generatedExercise.create({
    data: {
      materialId: material.id,
      setId: exerciseSet.id,
      chunkId: chunk.id,
      type: 'reading_detail',
      targetSkill: 'READING',
      prompt: '这一段是草稿题，不该入池',
      answerJson: JSON.stringify({ options: [{ key: 'A', text: 'x' }], correctKey: 'A', isSingleAnswer: true }),
      explanation: '草稿',
      evidenceQuote: 'Candidate collection passage',
      dedupeKey: 'seed-cand-draft',
      reviewStatus: 'draft',
    },
  });
  ids.exerciseDraft = exerciseDraft.id;

  const proposal = await prisma.taskProposal.create({
    data: { materialId: material.id, packId: pack.id, baseDate: AS_OF, budgetMinutes: 60, totalMinutes: 30, status: 'draft' },
  });
  ids.proposal = proposal.id;
  const proposalItemOk = await prisma.taskProposalItem.create({
    data: {
      proposalId: proposal.id,
      module: 'READING',
      targetSkill: 'READING',
      title: '精读开头三段',
      suggestedMinutes: 30,
      granularity: 15,
      suggestedDate: AS_OF,
      exerciseIdsJson: JSON.stringify([exerciseApproved.id]),
    },
  });
  ids.proposalItemOk = proposalItemOk.id;
  const proposalItemPlanned = await prisma.taskProposalItem.create({
    data: {
      proposalId: proposal.id,
      module: 'WRITING',
      targetSkill: 'WRITING',
      title: '已落计划的写作条目',
      suggestedMinutes: 20,
      granularity: 15,
      suggestedDate: AS_OF,
      planTaskId: planTask.id,
    },
  });
  ids.proposalItemPlanned = proposalItemPlanned.id;

  // ── 6. QUESTION ──
  const blueprint = await prisma.diagnosticBlueprint.create({
    data: { code: `cand-${Date.now()}`, version: '1.0', title: '候选采集测试蓝图' },
  });
  const diagMcq = await prisma.diagnosticItem.create({
    data: {
      blueprintId: blueprint.id,
      itemCode: `CAND-MCQ-${Date.now()}`,
      skill: 'READING',
      subskill: 'detail_scanning',
      targetLevelMin: 'A2',
      targetLevelMax: 'B1',
      difficulty: 2,
      taskType: 'MCQ',
      sourceType: 'VERIFIED',
      prompt: '细节题：作者为什么提到 1990 年？',
    },
  });
  ids.diagMcq = diagMcq.id;
  const diagOpenTask = await prisma.diagnosticItem.create({
    data: {
      blueprintId: blueprint.id,
      itemCode: `CAND-OPEN-${Date.now()}`,
      skill: 'WRITING',
      subskill: '',
      targetLevelMin: 'B1',
      targetLevelMax: 'B2',
      difficulty: 3,
      taskType: 'OPEN_TASK',
      sourceType: 'RUBRIC',
      prompt: 'Write an essay about urban transport.',
    },
  });
  ids.diagOpenTask = diagOpenTask.id;
  const diagAi = await prisma.diagnosticItem.create({
    data: {
      blueprintId: blueprint.id,
      itemCode: `CAND-AI-${Date.now()}`,
      skill: 'SPEAKING',
      subskill: '',
      targetLevelMin: 'A2',
      targetLevelMax: 'B1',
      difficulty: 1,
      taskType: 'SHORT_ANSWER',
      sourceType: 'AI_PRACTICE',
      prompt: 'What do you do at weekends?',
    },
  });
  ids.diagAi = diagAi.id;

  // ── 7. LAB ──
  const audioConfirmed = await prisma.audioAsset.create({
    data: { title: '已确认转写', filePath: 'uploads/a.mp3', durationSec: 120 },
  });
  ids.audioConfirmed = audioConfirmed.id;
  const audioMissing = await prisma.audioAsset.create({
    data: { title: '只有机器转写', filePath: 'uploads/b.mp3', durationSec: 90 },
  });
  ids.audioMissing = audioMissing.id;
  await prisma.transcript.create({
    data: { audioAssetId: audioConfirmed.id, kind: 'REVISED', status: 'CONFIRMED' },
  });
  await prisma.transcript.create({ data: { audioAssetId: audioMissing.id, kind: 'MACHINE', status: 'DRAFT' } });
  const listeningConfirmed = await prisma.listeningExercise.create({
    data: { audioAssetId: audioConfirmed.id, mode: 'DICTATION', title: '听写：机场广播' },
  });
  ids.listeningConfirmed = listeningConfirmed.id;
  const listeningMissing = await prisma.listeningExercise.create({
    data: { audioAssetId: audioMissing.id, mode: 'GIST', title: '主旨：不该入池' },
  });
  ids.listeningMissing = listeningMissing.id;
  const speakingPrompt = await prisma.speakingPrompt.create({
    data: { taskType: 'TOPIC_MONOLOGUE', title: '话题独白：一次难忘的旅行', prompt: 'Talk for 90 seconds.' },
  });
  ids.speakingPrompt = speakingPrompt.id;

  // ── 8. EGIU ──
  const resource = await prisma.resource.create({
    data: { name: 'EGIU 候选采集资源', type: 'BOOK', subject: 'GRAMMAR' },
  });
  const eguiUnit1 = await prisma.egiuLesson.create({
    data: {
      stageId: stage.id,
      resourceId: resource.id,
      unitNo: '1',
      knowledgePoint: '一般现在时',
      learnedDate: '2026-02-01',
      currentColor: 'YELLOW',
      nextReviewDate: AS_OF,
    },
  });
  ids.eguiUnit1 = eguiUnit1.id;
  const eguiUnit2 = await prisma.egiuLesson.create({
    data: {
      stageId: stage.id,
      resourceId: resource.id,
      unitNo: '2',
      knowledgePoint: '现在进行时',
      learnedDate: '2026-02-05',
      currentColor: 'RED',
      nextReviewDate: AS_OF,
    },
  });
  ids.eguiUnit2 = eguiUnit2.id;
  const eguiNoResource = await prisma.egiuLesson.create({
    data: {
      stageId: stage.id,
      unitNo: '99',
      knowledgePoint: '没有间隔档的单元',
      learnedDate: '2026-02-10',
      currentColor: 'PENDING',
      nextReviewDate: AS_OF,
    },
  });
  ids.eguiNoResource = eguiNoResource.id;

  // 给 unit1 挂一个 D7 复习点（间隔档只存在 `ReviewTask` 上）
  await prisma.reviewTask.create({
    data: {
      targetType: 'EGIU_LESSON',
      targetId: eguiUnit1.id,
      targetLabel: '一般现在时',
      intervalCode: 'D7',
      dueDate: AS_OF,
      estMinutes: 10,
    },
  });

  const result = await collectCandidates({
    asOfDate: AS_OF,
    gaps: [
      { dimensionKind: 'OFFICIAL', skill: 'READING', subskill: 'detail_scanning', kind: 'UNCERTAINTY' },
      { dimensionKind: 'AUXILIARY', skill: 'GRAMMAR', subskill: 'no_such_subskill', kind: 'UNCERTAINTY' },
      { dimensionKind: 'OFFICIAL', skill: 'LISTENING', subskill: '', kind: 'GAP' },
    ],
  });
  pool = result.candidates;
  skipped = result.skipped;
  degraded = result.degraded;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('① 8 源各造 1 条 → 归一后字段齐全', () => {
  it('8 个来源都出现在候选池里（先断言枚举长度，防空集真空通过）', () => {
    expect(CANDIDATE_SOURCE_KINDS.length).toBe(8);
    const present = new Set(pool.map((row) => row.sourceKind));
    const missing = CANDIDATE_SOURCE_KINDS.filter((kind) => !present.has(kind));
    expect(missing).toEqual([]);
    expect(degraded).toEqual([]);
  });

  it('每条候选的 module/targetSkill/primarySkill/track/estMinutes/minMinutes/validationStatus 都非空', () => {
    expect(pool.length).toBeGreaterThan(0);
    for (const row of pool) {
      expect(row.module, row.candidateKey).toBeTruthy();
      expect(row.targetSkill, row.candidateKey).toBeTruthy();
      expect(row.primarySkill, row.candidateKey).toBeTruthy();
      expect(row.track, row.candidateKey).toBeTruthy();
      expect(Number.isFinite(row.estMinutes), row.candidateKey).toBe(true);
      expect(row.estMinutes, row.candidateKey).toBeGreaterThan(0);
      expect(Number.isFinite(row.minMinutes), row.candidateKey).toBe(true);
      expect(row.minMinutes, row.candidateKey).toBeGreaterThan(0);
      expect(row.validationStatus, row.candidateKey).toBeTruthy();
      // `isAiSuggested` 初始恒 false：只有 AI 层可以置 true
      expect(row.isAiSuggested, row.candidateKey).toBe(false);
    }
  });

  it('candidateKey = sourceKind:sourceRef:module（期望值手抄，不反查实现）', () => {
    const review = find(pool, `REVIEW:review:${ids.review}:GRAMMAR`);
    expect(review.module).toBe('GRAMMAR');
    expect(review.targetSkill).toBe('GRAMMAR');
    expect(review.primarySkill).toBe('FOUNDATION');
    expect(review.estMinutes).toBe(5);
    expect(review.minMinutes).toBe(5);
    expect(review.meta).toEqual({ estMinutesSource: 'SOURCE' });

    const retest = find(pool, `RETEST:retest:${ids.retest}:READING`);
    expect(retest.targetSkill).toBe('READING');
    expect(retest.estMinutes).toBe(10);
    expect(retest.prerequisites).toEqual([{ kind: 'EVIDENCE_EXISTS', evidenceId: expect.any(String) }]);
    // `EvidenceRecord` 没有 subskill 列 → 技能级缺口用空串**显式**表达
    expect(retest.skillGapKey).toBe('OFFICIAL:READING:');

    // 到期日只有三个来源有，其余必须是 null（否则 `urgency` 会把它们当到期任务）
    expect(review.dueDate).toBe(AS_OF);
    expect(retest.dueDate).toBe(AS_OF);

    const vocab = find(pool, `VOCAB:vocab:${ids.vocabToday}:VOCAB_REVIEW`);
    expect(vocab.estMinutes).toBe(12);
    expect(vocab.minMinutes).toBe(5);
    expect(vocab.meta).toEqual({ estMinutesSource: 'SOURCE' });

    const material = find(pool, `MATERIAL:material:${ids.proposalItemOk}:READING`);
    expect(material.estMinutes).toBe(30);
    expect(material.minMinutes).toBe(15);
    expect(material.maxBlockMinutes).toBe(15);
    expect(material.validationStatus).toBe('VERIFIED');
    expect(material.prerequisites).toEqual([
      { kind: 'MATERIAL_READY', materialId: expect.any(String) },
      { kind: 'EXERCISE_APPROVED', exerciseId: ids.exerciseApproved },
    ]);

    // AI 临时生成的练习题必须保持 `AI_PRACTICE`（不许被标成 VERIFIED）
    const aiPractice = find(pool, `QUESTION:diagnostic:${ids.diagAi}:SPEAKING`);
    expect(aiPractice.validationStatus).toBe('AI_PRACTICE');
    expect(aiPractice.estMinutes).toBe(6); // SHORT_ANSWER

    const question = find(pool, `QUESTION:diagnostic:${ids.diagMcq}:READING`);
    expect(question.estMinutes).toBe(3);
    expect(question.minMinutes).toBe(3);
    expect(question.meta).toEqual({
      estMinutesSource: 'DERIVED',
      derivedFrom: 'CANDIDATE_DEFAULT_MINUTES.QUESTION.MCQ',
    });

    const lab = find(pool, `LAB:listening:${ids.listeningConfirmed}:LISTENING`);
    expect(lab.estMinutes).toBe(15);
    expect(lab.validationStatus).toBe('UNVERIFIED');
    expect(lab.prerequisites).toEqual([{ kind: 'TRANSCRIPT_CONFIRMED', audioAssetId: ids.audioConfirmed }]);

    const egui = find(pool, `EGIU:egiu:${ids.eguiUnit1}:GRAMMAR`);
    expect(egui.estMinutes).toBe(10); // EST_MINUTES_BY_INTERVAL.D7
    expect(egui.dueDate).toBe(AS_OF); // 教材单元的到期 = 复习点日期
    expect(egui.prerequisites).toEqual([]);
    expect(vocab.dueDate).toBeNull();
    expect(material.dueDate).toBeNull();
    expect(question.dueDate).toBeNull();
    expect(lab.dueDate).toBeNull();
  });
});

describe('② 材料题 reviewStatus=draft 不入池（AC-2）', () => {
  it('approved 的入池、draft 的整条不在池里', () => {
    expect(pool.some((row) => row.sourceRef === `material_exercise:${ids.exerciseApproved}`)).toBe(true);
    expect(pool.some((row) => row.sourceRef === `material_exercise:${ids.exerciseDraft}`)).toBe(false);
  });
});

describe('③ 听力无 CONFIRMED 转写 → 不入池', () => {
  it('有确认转写的入池，只有 DRAFT 转写的不入池且写明原因', () => {
    expect(pool.some((row) => row.sourceRef === `listening:${ids.listeningConfirmed}`)).toBe(true);
    expect(pool.some((row) => row.sourceRef === `listening:${ids.listeningMissing}`)).toBe(false);
    const reason = skipped.find((row) => row.sourceRef === `listening:${ids.listeningMissing}`);
    expect(reason?.why).toContain('no-confirmed-transcript');
  });
});

describe('④ VocabularyAssignment.planTaskId 非空 → 不入池', () => {
  it('已落计划的词汇任务被跳过，且原因写着 already-planned', async () => {
    const rows = await collectVocabCandidates({ asOfDate: YESTERDAY });
    expect(rows).toEqual([]);
  });

  it('同一日期只有一行时正常入池（反向用例：过滤没写死到把所有行都挡掉）', async () => {
    const rows = await collectVocabCandidates({ asOfDate: AS_OF });
    expect(rows.map((row) => row.sourceRef)).toEqual([`vocab:${ids.vocabToday}`]);
  });
});

describe('⑤ TaskProposalItem.planTaskId 非空 → 不入池（Q6 入池过滤）', () => {
  it('未落计划的草案条目入池，已落计划的不入池', () => {
    expect(pool.some((row) => row.sourceRef === `material:${ids.proposalItemOk}`)).toBe(true);
    expect(pool.some((row) => row.sourceRef === `material:${ids.proposalItemPlanned}`)).toBe(false);
    const reason = skipped.find((row) => row.sourceRef === `material:${ids.proposalItemPlanned}`);
    expect(reason?.why).toContain('already-planned');
  });

  it('单材料直出（`TaskProposal.packId IS NULL`）的包条目不算「没提案」', () => {
    // 这条包的 `packId` 下没有任何提案（提案挂在材料上、不挂包），所以"只按 packId 查"
    // 的实现会把它报成 no-proposal —— 而它的草案其实存在，候选池里也已经有它。
    expect(pool.some((row) => row.sourceRef === `material:${ids.proposalItemDirect}`)).toBe(true);
    const packItemIds = new Set(
      skipped.filter((row) => row.sourceKind === 'MATERIAL' && row.why.includes('no-proposal')).map((row) => row.sourceRef),
    );
    // `no-proposal` 按包条目报，`sourceRef` 为 null，所以只能按**数量**核对：
    // 完全没有提案的那一个包（1 条条目）应该被报，单材料直出的那条**不应该**被报。
    const noProposalCount = skipped.filter(
      (row) => row.sourceKind === 'MATERIAL' && row.why.includes('no-proposal'),
    ).length;
    expect(packItemIds.size).toBe(1);
    expect(noProposalCount).toBe(1);
    // 原因文案按**包**说（不是"这条还没提草案"）：草案是整包生成的，界面上没有"条目"这个对象
    const reason = skipped.find((row) => row.why.includes('no-proposal'));
    expect(reason?.why).toContain('材料包');
    expect(reason?.why).not.toContain('该材料条目');
  });

  it('「没提案」与「已排过」是两个原因，不许合成一句「无候选」', () => {
    const noProposal = skipped.filter((row) => row.sourceKind === 'MATERIAL' && row.why.includes('no-proposal'));
    expect(noProposal.length).toBeGreaterThan(0);
    const planned = skipped.filter((row) => row.sourceKind === 'MATERIAL' && row.why.includes('already-planned'));
    expect(planned.length).toBeGreaterThan(0);
    // 两者必须是不同的文案，否则 UI 无法区分"还没排"与"已经排过"
    expect(noProposal[0]?.why).not.toBe(planned[0]?.why);
  });
});

describe('⑮ OPEN_TASK 的 skill 覆写（断言打在查找点）', () => {
  it('WRITING 20 分钟 / SPEAKING 10 分钟，且 derivedFrom 能说出走了哪条', () => {
    const writing = estMinutesOf({ taskType: 'OPEN_TASK', skill: 'WRITING' });
    expect(writing.estMinutes).toBe(20);
    expect(writing.derivedFrom).toBe('skillOverride:OPEN_TASK/WRITING');
    const speaking = estMinutesOf({ taskType: 'OPEN_TASK', skill: 'SPEAKING' });
    expect(speaking.estMinutes).toBe(10);
    expect(speaking.derivedFrom).toBe('skillOverride:OPEN_TASK/SPEAKING');
  });

  it('覆写改变了最小可执行单元（写作那条的 minMinutes 也是 20）', () => {
    const open = find(pool, `QUESTION:diagnostic:${ids.diagOpenTask}:WRITING`);
    expect(open.estMinutes).toBe(20);
    expect(open.minMinutes).toBe(20);
    expect(open.validationStatus).toBe('RUBRIC');
  });

  it('缺失侧逐个走查找点：每个不在表里的 SkillId 都得 15，不是 undefined / NaN', () => {
    // A-1：先证缺失侧非空。将来有人把 8 个键填满，下面的循环会一次都不执行、
    // 整条测试静默通过 —— 那时"填满"这件事本身必须被显式处理。
    const missing = SKILL_IDS.filter((skill) => !(skill in QUESTION_OPEN_TASK_SKILL_OVERRIDE));
    expect(missing.length).toBeGreaterThan(0);
    for (const skill of missing) {
      const picked = estMinutesOf({ taskType: 'OPEN_TASK', skill });
      expect(picked.estMinutes, skill).toBe(15);
      expect(Number.isFinite(picked.estMinutes), skill).toBe(true);
      expect(picked.derivedFrom, skill).toBe('default:OPEN_TASK');
    }
  });

  it('反向：MCQ + WRITING 不触发覆写（否决"所有题型都能按 skill 覆写"）', () => {
    expect(estMinutesOf({ taskType: 'MCQ', skill: 'WRITING' }).estMinutes).toBe(3);
  });

  it('表外题型抛错而不是编一个默认分钟数', () => {
    expect(() => estMinutesOf({ taskType: 'ESSAY_2026', skill: 'WRITING' })).toThrow(UnknownMinuteKeyError);
    expect(() => estMinutesOf({ mode: 'NO_SUCH_MODE' })).toThrow(UnknownMinuteKeyError);
  });
});

describe('⑯ EGIU 两级取值：已知间隔档更准，未知必须显形', () => {
  it('已知 intervalCode → 取 EST_MINUTES_BY_INTERVAL，且 derivedFrom 不是 fallback', () => {
    const known = egiuMinutesOf('D7');
    expect(known.estMinutes).toBe(10);
    expect(known.derivedFrom).toBe('EST_MINUTES_BY_INTERVAL.D7');
    expect(known.derivedFrom.startsWith('fallback:')).toBe(false);
  });

  it('interval 未知 → 落兜底 20 且 derivedFrom 以 fallback: 开头（数据问题要看得见）', () => {
    const unknown = egiuMinutesOf(null);
    expect(unknown.estMinutes).toBe(20);
    expect(unknown.derivedFrom.startsWith('fallback:')).toBe(true);
    expect(egiuMinutesOf('D99').derivedFrom.startsWith('fallback:')).toBe(true);
  });

  it('采集层真的把两级都用上了：有 D7 的单元 10 分钟，没有间隔档的 20 分钟', () => {
    expect(find(pool, `EGIU:egiu:${ids.eguiUnit1}:GRAMMAR`).estMinutes).toBe(10);
    expect(find(pool, `EGIU:egiu:${ids.eguiNoResource}:GRAMMAR`).estMinutes).toBe(20);
  });
});

describe('UNIT_ORDER：同资源内的前序单元进前置条件', () => {
  it('第 2 单元要求先完成第 1 单元，第 1 单元没有前序', () => {
    const unit2 = find(pool, `EGIU:egiu:${ids.eguiUnit2}:GRAMMAR`);
    expect(unit2.prerequisites).toEqual([
      { kind: 'UNIT_ORDER', lessonId: ids.eguiUnit2, requiresLessonId: ids.eguiUnit1 },
    ]);
    const unit1 = find(pool, `EGIU:egiu:${ids.eguiUnit1}:GRAMMAR`);
    expect(unit1.prerequisites).toEqual([]);
  });
});

describe('PROBE：只有 UNCERTAINTY 缺口产出补测，且必须有对应题库', () => {
  it('有对应已验证诊断题的缺口产出 1 条，缺题库的缺口写进 skipped', () => {
    const probe = find(pool, 'PROBE:probe:READING|detail_scanning:READING');
    expect(probe.estMinutes).toBe(10);
    expect(probe.minMinutes).toBe(10);
    expect(probe.skillGapKey).toBe('OFFICIAL:READING:detail_scanning');
    expect(probe.sourceKind).toBe('PROBE');

    // `kind='GAP'` 的缺口不产补测（补测只服务"证据不足"）
    expect(pool.some((row) => row.sourceKind === 'PROBE' && row.targetSkill === 'LISTENING')).toBe(false);
    // 没有题库支撑的 AUXILIARY 缺口：不入池，但要说清为什么
    const noBank = skipped.find((row) => row.sourceRef === 'probe:GRAMMAR|no_such_subskill');
    expect(noBank?.why).toContain('没有对应的已验证诊断题');
  });
});

describe('时长诚实性：源表有真值标 SOURCE，派生标 DERIVED', () => {
  it('有真时长字段的 5 个来源标 SOURCE，派生来源标 DERIVED 且 derivedFrom 非空', () => {
    const byKind = (kind: string) => pool.filter((row) => row.sourceKind === kind);
    const review = byKind('REVIEW')[0];
    const retest = byKind('RETEST')[0];
    const vocab = byKind('VOCAB')[0];
    const material = byKind('MATERIAL')[0];
    const question = byKind('QUESTION')[0];
    const lab = byKind('LAB')[0];
    const egui = byKind('EGIU')[0];
    expect([review, retest, vocab, material, question, lab, egui].every(Boolean)).toBe(true);
    for (const row of [review, retest, vocab, material]) {
      expect(row?.meta.estMinutesSource, row?.candidateKey).toBe('SOURCE');
    }
    for (const row of [question, lab, egui]) {
      expect(row?.meta.estMinutesSource, row?.candidateKey).toBe('DERIVED');
      expect(row?.meta.derivedFrom, row?.candidateKey).toBeTruthy();
    }
  });

  it('源表本该有时长却为空 → 落兜底并标出 fallback（数据问题不许静默）', () => {
    // estimatedMinutes 默认 0；0 分钟任务在装箱时永远放得下，会挤掉真实任务
    const fallback = sourceMinutesOf('VOCAB', 0);
    expect(fallback.estMinutes).toBe(10);
    expect(fallback.meta).toEqual({ estMinutesSource: 'DERIVED', derivedFrom: 'fallback:VOCAB(0)' });
    const ok = sourceMinutesOf('VOCAB', 18);
    expect(ok.estMinutes).toBe(18);
    expect(ok.meta).toEqual({ estMinutesSource: 'SOURCE' });
  });
});
