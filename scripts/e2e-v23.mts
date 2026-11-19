/**
 * v2.3 端到端验收（真实数据库副本）。
 *
 * 覆盖：
 *   TypeWords 备份生成 → 解析 → 词条落库 → 两条重叠统计导入（时长只计一次）
 *   → 幂等重跑 → 词汇分配生成/重算 → 旧表与历史记录不变。
 *
 * 与 e2e-v22 相同的安全边界：复制 dev.db 到临时目录，真实库只读。
 * 不直接调用 Server Action（revalidatePath 需要 Next 请求上下文），
 * 这里调用 Action 内部同一份事务助手 `importTypeWordsBackupInTx`。
 */

import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const sourceDb = join(repoRoot, 'prisma', 'dev.db');
const workDb = join(tmpdir(), `ielts-e2e-v23-${Date.now()}.db`);

if (!existsSync(sourceDb)) {
  console.error(`[FAIL] 找不到真实数据库：${sourceDb}`);
  process.exit(1);
}
copyFileSync(sourceDb, workDb);
process.env.DATABASE_URL = `file:${workDb}`;

const { PrismaClient } = await import('@prisma/client');
const { buildTypeWordsBackup, parseTypeWordsBackup, effectiveSeconds } = await import(
  '../src/lib/domain/vocabSync'
);
const { importTypeWordsBackupInTx } = await import('../src/lib/vocabBackupImport');
const { ensureVocabularyAssignment } = await import('../src/lib/vocabAssignment');
const { ensureVocabularyRetest } = await import('../src/lib/vocabRetest');
const { buildImportPreview } = await import('../src/lib/domain/vocabImport');

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const DATE = '2099-01-15';
const DAY_START = Date.parse(`${DATE}T01:00:00.000Z`);

interface Statistic {
  startDate: number;
  spend: number;
  total: number;
  new: number;
  review: number;
  wrong: number;
  segments: Array<[number, number]>;
  sessionRole: string;
  title: string;
}

function statistic(startMin: number, endMin: number, title: string): Statistic {
  const start = DAY_START + startMin * 60_000;
  const end = DAY_START + endMin * 60_000;
  return {
    startDate: start,
    spend: end - start,
    total: 20,
    new: 5,
    review: 15,
    wrong: 2,
    segments: [[start, end]],
    sessionRole: 'single',
    title,
  };
}

async function main() {
  console.log('== v2.3 端到端验收（数据库副本）==');
  console.log(`副本：${workDb}\n`);

  const before = {
    legacyWords: await prisma.vocabWord.count(),
    legacyQuizzes: await prisma.vocabQuiz.count(),
    evidence: await prisma.evidenceRecord.count(),
    planTasks: await prisma.planTask.count(),
  };

  // ── ① 生成并解析兼容包 ────────────────────────────────────────────────
  console.log('[1] 兼容包生成与解析');
  const words = ['abandon', 'benefit', 'crucial'].map((lemma, index) => ({
    lemma,
    normalizedLemma: lemma,
    pos: 'v',
    senseKey: 'default',
    definitionZh: `释义 ${index + 1}`,
    definitionEn: null,
    phoneticUk: null,
    phoneticUs: null,
    examples: [`This is ${lemma}.`],
    collocations: [],
    tags: [],
    sourceRef: `e2e-${index}`,
  }));

  const backup = buildTypeWordsBackup({ deckId: 'e2e-deck', title: 'E2E 词库', words }) as any;
  backup.val.dict.val.word.bookList[0].statistics = [
    statistic(0, 20, '上午'),
    statistic(10, 30, '上午续'),
  ];
  const text = JSON.stringify(backup);

  const parsed = parseTypeWordsBackup(text);
  check('解析出 3 个词条', parsed.words.length === 3, `got=${parsed.words.length}`);
  check('解析出 2 条统计', parsed.sessions.length === 2, `got=${parsed.sessions.length}`);
  check('词典名保留', parsed.dictNames[0] === 'E2E 词库', parsed.dictNames.join(','));
  check('无解析警告', parsed.warnings.length === 0, parsed.warnings.join('；'));

  const first = parsed.sessions[0]!;
  const second = parsed.sessions[1]!;
  const firstSeconds = effectiveSeconds(
    { startMs: Date.parse(first.startedAt), endMs: Date.parse(first.endedAt) },
    [],
  );
  const secondSeconds = effectiveSeconds(
    { startMs: Date.parse(second.startedAt), endMs: Date.parse(second.endedAt) },
    [{ startMs: Date.parse(first.startedAt), endMs: Date.parse(first.endedAt) }],
  );
  check('第一条 20 分钟', firstSeconds === 1200, `got=${firstSeconds}`);
  check('第二条重叠 10 分钟后只剩 10 分钟', secondSeconds === 600, `got=${secondSeconds}`);

  // ── ② 导入事务 ────────────────────────────────────────────────────────
  console.log('[2] 备份导入（词条 + 汇总会话）');
  const job1 = await prisma.integrationJob.create({
    data: {
      provider: 'TYPEWORDS',
      direction: 'IMPORT_BACKUP',
      status: 'running',
      fileName: 'e2e-typewords.json',
      payloadHash: 'e2e-hash-1',
      payloadText: text,
      startedAt: new Date(),
    },
    select: { id: true },
  });

  const run1 = await prisma.$transaction(
    (tx) =>
      importTypeWordsBackupInTx(tx, {
        backup: parsed,
        jobId: job1.id,
        connectionId: null,
        countTime: true,
        payloadHash: 'e2e-hash-1',
      }),
    { timeout: 120_000 },
  );

  check('新增 3 个词条', run1.persisted.created === 3, `created=${run1.persisted.created}`);
  check('导入 2 条会话', run1.sessionsImported === 2, `imported=${run1.sessionsImported}`);
  check('计入 30 分钟（不是 40）', run1.minutesCounted === 30, `minutes=${run1.minutesCounted}`);

  const practice = await prisma.vocabularyPracticeSession.findMany({
    where: { externalSessionId: { in: parsed.sessions.map((session) => session.canonicalKey) } },
    orderBy: { startedAt: 'asc' },
  });
  check('两条会话都是 SUMMARY_ONLY', practice.every((row) => row.granularity === 'SUMMARY_ONLY'));
  check('第二条标注重叠', practice[1]?.overlapAdjusted === true);
  check('每条会话都挂了 StudySession', practice.every((row) => !!row.studySessionId));

  const splits = await prisma.studySessionDaySplit.aggregate({
    where: { sessionId: { in: practice.map((row) => row.studySessionId!) } },
    _sum: { minutes: true },
  });
  check('DaySplit 合计 30 分钟', splits._sum.minutes === 30, `sum=${splits._sum.minutes}`);

  const studies = await prisma.studySession.findMany({
    where: { id: { in: practice.map((row) => row.studySessionId!) } },
  });
  check('StudySession 技能为词汇模块主技能', studies.every((row) => row.skill === 'FOUNDATION'));
  check('StudySession 轨道为通用英语', studies.every((row) => row.track === 'GENERAL_ENGLISH'));

  const attempts = await prisma.vocabularyAttempt.count();
  check('汇总导入不产生逐词尝试', attempts === 0, `attempts=${attempts}`);

  // ── ③ 幂等重跑 ────────────────────────────────────────────────────────
  console.log('[3] 幂等重跑');
  const job2 = await prisma.integrationJob.create({
    data: {
      provider: 'TYPEWORDS',
      direction: 'IMPORT_BACKUP',
      status: 'running',
      fileName: 'e2e-typewords.json',
      payloadHash: 'e2e-hash-1',
      payloadText: text,
      startedAt: new Date(),
    },
    select: { id: true },
  });
  const run2 = await prisma.$transaction(
    (tx) =>
      importTypeWordsBackupInTx(tx, {
        backup: parsed,
        jobId: job2.id,
        connectionId: null,
        countTime: true,
        payloadHash: 'e2e-hash-2',
      }),
    { timeout: 120_000 },
  );
  check('重跑不新增词条', run2.persisted.created === 0, `created=${run2.persisted.created}`);
  check('重跑跳过 2 条会话', run2.sessionsSkipped === 2, `skipped=${run2.sessionsSkipped}`);
  check('重跑不计时长', run2.minutesCounted === 0, `minutes=${run2.minutesCounted}`);
  check(
    '会话总数仍为 2',
    (await prisma.vocabularyPracticeSession.count({
      where: { externalSessionId: { in: parsed.sessions.map((session) => session.canonicalKey) } },
    })) === 2,
  );

  // ── ④ 词汇分配 ────────────────────────────────────────────────────────
  console.log('[4] 词汇分配生成与重算');
  const [item] = await prisma.vocabularyItem.findMany({
    where: { normalizedLemma: 'abandon' },
    select: { id: true },
  });
  await prisma.vocabularyKnowledgeState.createMany({
    data: [
      {
        itemId: item!.id,
        dimension: 'MEANING_RECOGNITION',
        status: 'RECALLED',
        confidence: 'HIGH',
        evidenceCount: 3,
        lastVerifiedAt: '2098-12-20',
      },
    ],
  });

  const assignment1 = await prisma.$transaction((tx) =>
    ensureVocabularyAssignment(tx, { assignmentDate: DATE, budgetMinutes: 30 }),
  );
  check('生成一条词汇分配', !!assignment1.assignmentId);
  check('复习目标至少 1', assignment1.reviewTarget >= 1, `review=${assignment1.reviewTarget}`);

  const assignment2 = await prisma.$transaction((tx) =>
    ensureVocabularyAssignment(tx, {
      assignmentDate: DATE,
      budgetMinutes: 60,
      recomputeWhenUnstarted: true,
    }),
  );
  const assignmentRows = await prisma.vocabularyAssignment.findMany({
    where: { assignmentDate: DATE },
    select: { budgetMinutes: true, reviewTarget: true },
  });
  check('同一天仍只有一条分配', assignmentRows.length === 1, `rows=${assignmentRows.length}`);
  check('重算后预算为 60', assignmentRows[0]?.budgetMinutes === 60, `budget=${assignmentRows[0]?.budgetMinutes}`);
  check(
    '重算后是新的分配记录',
    assignment2.assignmentId !== null && assignment2.assignmentId !== assignment1.assignmentId,
  );

  // ── ⑤ 词汇维度延迟复测 ────────────────────────────────────────────────
  console.log('[5] 词汇维度延迟复测');
  const retestEvidence1 = await prisma.evidenceRecord.create({
    data: {
      skill: 'VOCABULARY',
      evidenceType: 'APPLIED_TASK',
      level: 'STANDARD',
      assistanceLevel: 'A0',
      score: 2,
      createdAt: new Date('2098-12-20T04:00:00Z'),
      updatedAt: new Date('2098-12-20T04:00:00Z'),
    },
    select: { id: true },
  });
  const retest1 = await prisma.$transaction((tx) =>
    ensureVocabularyRetest(tx, {
      evidenceId: retestEvidence1.id,
      itemId: item!.id,
      lemma: 'abandon',
      dimension: 'MEANING_RECALL',
      status: 'RECALLED',
      createdAt: new Date('2098-12-20T04:00:00Z'),
    }),
  );
  check('首次排 3 条延迟复测', retest1.created === 3, `created=${retest1.created}`);
  const retestRows = await prisma.retestSchedule.findMany({
    where: { note: { startsWith: `VOCAB|${item!.id}|MEANING_RECALL|` } },
    orderBy: { dueDate: 'asc' },
    select: { dueDate: true, retestType: true, status: true },
  });
  check(
    '复测间隔为隔日 / 7 天 / 30 天',
    retestRows.map((row) => row.dueDate).join(',') === '2098-12-21,2098-12-27,2099-01-19',
    retestRows.map((row) => row.dueDate).join(','),
  );
  check('复测类型为 DELAYED', retestRows.every((row) => row.retestType === 'DELAYED'));

  const retestEvidence2 = await prisma.evidenceRecord.create({
    data: {
      skill: 'VOCABULARY',
      evidenceType: 'APPLIED_TASK',
      level: 'STANDARD',
      assistanceLevel: 'A0',
      score: 2,
      createdAt: new Date('2098-12-22T04:00:00Z'),
      updatedAt: new Date('2098-12-22T04:00:00Z'),
    },
    select: { id: true },
  });
  const retest2 = await prisma.$transaction((tx) =>
    ensureVocabularyRetest(tx, {
      evidenceId: retestEvidence2.id,
      itemId: item!.id,
      lemma: 'abandon',
      dimension: 'MEANING_RECALL',
      status: 'RECALLED',
      createdAt: new Date('2098-12-22T04:00:00Z'),
    }),
  );
  check('到期复测被新证据结清 1 条', retest2.completed === 1, `completed=${retest2.completed}`);
  const completedRow = await prisma.retestSchedule.findFirst({
    where: {
      note: { startsWith: `VOCAB|${item!.id}|MEANING_RECALL|` },
      dueDate: '2098-12-21',
    },
    select: { status: true, completedEvidenceId: true },
  });
  check(
    '结清记录挂到新证据上',
    completedRow?.status === 'DONE' && completedRow.completedEvidenceId === retestEvidence2.id,
    `status=${completedRow?.status}`,
  );
  check('未来排期不提前结清', retestRows.length === 3);

  // ── ⑥ 词表导入预览（CSV）──────────────────────────────────────────────
  console.log('[6] CSV 预览不写库');
  const csv = 'word,pos,meaning,例句\nleverage,v,利用,We leverage data.\nleverage,v,利用,重复行\n';
  const preview = buildImportPreview({ fileName: 'e2e.csv', text: csv });
  check('预览识别 2 行', preview.total === 2, `total=${preview.total}`);
  check('文件内重复被标记', preview.counts.DUPLICATE_IN_FILE === 1, JSON.stringify(preview.counts));
  check(
    '预览前后词条数不变',
    (await prisma.vocabularyItem.count({ where: { normalizedLemma: 'leverage' } })) === 0,
  );

  // ── ⑦ 只读核对 ────────────────────────────────────────────────────────
  console.log('[7] 只读核对');
  check('旧 VocabWord 未变化', (await prisma.vocabWord.count()) === before.legacyWords);
  check('旧 VocabQuiz 未变化', (await prisma.vocabQuiz.count()) === before.legacyQuizzes);
  check(
    '旧证据未被词汇复测改动',
    (await prisma.evidenceRecord.count()) === before.evidence + 2,
    `evidence=${await prisma.evidenceRecord.count()}`,
  );
  check('PlanTask 未变化', (await prisma.planTask.count()) === before.planTasks);

  const job = await prisma.integrationJob.findUnique({
    where: { id: job1.id },
    select: { status: true, countsJson: true },
  });
  check('首个导入任务成功', job?.status === 'succeeded', `status=${job?.status}`);
  check('任务留下计数快照', !!job?.countsJson);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) {
    console.log('失败项：');
    for (const itemFailure of failures) console.log(`  - ${itemFailure}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.stack : String(error)}`);
  failed += 1;
} finally {
  await prisma.$disconnect();
  rmSync(workDb, { force: true });
  rmSync(`${workDb}-journal`, { force: true });
  if (failed > 0) process.exitCode = 1;
}
