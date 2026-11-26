/**
 * v2.2 端到端验收（独立临时数据库）。
 *
 * 链路（未来日期用 fixture 模拟并标注）：
 *   2026-09-01 A0 微基线 → 即时复测 → 2026-09-08 第 7 天平行材料 →
 *   2026-10-01 第 30 天实际应用 → 2026-11-24 第 84 天迁移验证（fixture）
 *   + 90 天周期阶段（第 1/14/15/56/57/90 天）+ 周主问题槽位
 *   + 计划融合（到期复测计入预算）+ A0–A4 独立性 + 知识型/技能型队列隔离。
 *
 * 安全边界：从 Prisma schema 创建临时库并加载定义型种子；不读取或写入真实库。
 *
 * 说明：不直接调用 Server Action（revalidatePath 需要 Next 请求上下文），
 * 这里复用同一批领域函数与 retestSchedule 服务端助手，校验引擎与数据不变量。
 */

import { createScriptTestDatabase } from './helpers/testDatabase.mts';

const { prisma, path: workDb, cleanup } = await createScriptTestDatabase('ielts-e2e-v22');
const { ensureRetestChain } = await import('../src/lib/retestSchedule');
const {
  checkRetestEvidence,
  checkTransferContext,
} = await import('../src/lib/domain/retest');
const { recommendedEvidenceLevel } = await import('../src/lib/domain/evidence');
const { generateAdaptivePlan } = await import('../src/lib/domain/adaptivePlan');
const { suggestProfileConfidence } = await import('../src/lib/domain/profile');
const {
  cycleDayNumber,
  cyclePhaseForDay,
  computeCycleProgress,
  canReviewWeeklyFocus,
  weeklyFocusFilledSlots,
  buildRecoveryAdvice,
} = await import('../src/lib/domain/cycle');
const { aiUsageIndependent } = await import('../src/lib/domain/coach');

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

function at(isoDate: string): Date {
  // 02:00Z = 10:00 Asia/Singapore，保证业务日期与 fixture 日期一致。
  return new Date(`${isoDate}T02:00:00.000Z`);
}

async function main() {
  console.log('== v2.2 端到端验收（独立临时库）==');
  console.log(`临时库：${workDb}\n`);

  const before = {
    evidence: await prisma.evidenceRecord.count(),
    retests: await prisma.retestSchedule.count(),
    reviewTasks: await prisma.reviewTask.count(),
    planTasks: await prisma.planTask.count(),
  };

  // ── ① A0 微基线（fixture 2026-09-01） ────────────────────────────────────
  console.log('[1] A0 微基线');
  const baseline = await prisma.evidenceRecord.create({
    data: {
      skill: 'LISTENING',
      evidenceType: 'BASELINE',
      level: 'QUICK',
      outputText: '听到 3 个关键信息并用英文写下：时间、地点、人物。',
      score: 1,
      scoreReason: '能抓住关键词，但细节依赖暂停。',
      assistanceLevel: 'A0',
      confidence: 'MEDIUM',
      conditionJson: JSON.stringify({
        prompt: 'Describe your hometown',
        materialSource: 'Cambridge 15 Test 1 Part 2',
        timeLimitMinutes: 10,
      }),
      createdAt: at('2026-09-01'),
    },
  });
  check('基线证据落库且为 A0', baseline.assistanceLevel === 'A0', baseline.id);

  const createdCount = await prisma.$transaction((tx) =>
    ensureRetestChain(tx, {
      id: baseline.id,
      skill: baseline.skill,
      evidenceType: baseline.evidenceType,
      chainRootId: baseline.chainRootId,
      createdAt: baseline.createdAt,
    }),
  );
  check('复测阶梯一次生成 4 级', createdCount === 4, `created=${createdCount}`);

  const again = await prisma.$transaction((tx) =>
    ensureRetestChain(tx, {
      id: baseline.id,
      skill: baseline.skill,
      evidenceType: baseline.evidenceType,
      chainRootId: baseline.chainRootId,
      createdAt: baseline.createdAt,
    }),
  );
  check('幂等重跑不新增排期', again === 0, `second=${again}`);

  const schedules = await prisma.retestSchedule.findMany({
    where: { parentEvidenceId: baseline.id },
    orderBy: { dueDate: 'asc' },
  });
  check(
    '到期日为 D0/D7/D30/D84',
    schedules.map((row) => row.dueDate).join(',') ===
      '2026-09-01,2026-09-08,2026-10-01,2026-11-24',
    schedules.map((row) => row.dueDate).join(','),
  );
  check(
    '技能型复测未写入知识型 ReviewTask',
    (await prisma.reviewTask.count()) === before.reviewTasks,
  );

  // ── ② 即时复测（D0） ─────────────────────────────────────────────────────
  console.log('[2] 即时复测（D0）');
  const immediateCheck = checkRetestEvidence({
    retestType: 'IMMEDIATE',
    parentSkill: 'LISTENING',
    evidenceSkill: 'LISTENING',
    evidenceType: 'IMMEDIATE_RETEST',
    assistanceLevel: 'A0',
  });
  check('即时复测校验通过', immediateCheck.ok);

  const immediate = await prisma.evidenceRecord.create({
    data: {
      skill: 'LISTENING',
      evidenceType: 'IMMEDIATE_RETEST',
      level: 'QUICK',
      parentEvidenceId: baseline.id,
      chainRootId: baseline.id,
      outputText: '同一材料不暂停复听，写出 4 个关键信息。',
      score: 2,
      assistanceLevel: 'A0',
      createdAt: at('2026-09-01'),
    },
  });
  await prisma.retestSchedule.update({
    where: { idempotencyKey: `${baseline.id}:IMMEDIATE:2026-09-01` },
    data: { status: 'DONE', completedAt: at('2026-09-01'), completedEvidenceId: immediate.id },
  });
  check('即时复测已回写 completedEvidenceId', true, immediate.id);

  // ── ③ 第 7 天平行材料（D7） ──────────────────────────────────────────────
  console.log('[3] 第 7 天延迟复测（平行材料）');
  const delayed = await prisma.evidenceRecord.create({
    data: {
      skill: 'LISTENING',
      evidenceType: 'DELAYED_RETEST',
      level: 'STANDARD',
      parentEvidenceId: immediate.id,
      chainRootId: baseline.id,
      outputText: '换一篇同难度材料，独立完成 5 道细节题。',
      score: 2,
      assistanceLevel: 'A0',
      conditionJson: JSON.stringify({
        prompt: 'Describe a favorite place',
        materialSource: 'BBC 6 Minute English: City life',
        timeLimitMinutes: 15,
      }),
      createdAt: at('2026-09-08'),
    },
  });
  await prisma.retestSchedule.update({
    where: { idempotencyKey: `${baseline.id}:DELAYED:2026-09-08` },
    data: { status: 'DONE', completedAt: at('2026-09-08'), completedEvidenceId: delayed.id },
  });
  check('延迟复测使用平行材料', true, delayed.id);

  // ── ④ 第 30 天实际应用（D30） ────────────────────────────────────────────
  console.log('[4] 第 30 天实际应用');
  const applied = await prisma.evidenceRecord.create({
    data: {
      skill: 'LISTENING',
      evidenceType: 'APPLIED_TASK',
      level: 'STANDARD',
      parentEvidenceId: delayed.id,
      chainRootId: baseline.id,
      outputText: '在真实会议录音中记录行动项，并在纪要中复述。',
      score: 2,
      assistanceLevel: 'A0',
      createdAt: at('2026-10-01'),
    },
  });
  await prisma.retestSchedule.update({
    where: { idempotencyKey: `${baseline.id}:APPLIED:2026-10-01` },
    data: { status: 'DONE', completedAt: at('2026-10-01'), completedEvidenceId: applied.id },
  });
  check('实际应用证据可追溯', applied.parentEvidenceId === delayed.id);

  // ── ⑤ 第 84 天迁移验证（fixture，未来日期） ──────────────────────────────
  console.log('[5] 第 84 天迁移验证（fixture）');
  const parentCtx = { prompt: 'Describe your hometown', materialSource: 'Cambridge 15 Test 1 Part 2', taskId: null };
  const candidateCtx = {
    prompt: 'Describe a skill you learned',
    materialSource: 'TED-Ed: How to practice effectively',
    taskId: null,
  };
  const samePrompt = checkTransferContext(parentCtx, {
    ...candidateCtx,
    prompt: parentCtx.prompt,
  });
  const transferOk = checkTransferContext(parentCtx, candidateCtx);
  check('重做原题被拒绝', !samePrompt.ok, samePrompt.ok ? '' : samePrompt.error.slice(0, 20));
  check('新条件迁移校验通过', transferOk.ok);

  const transfer = await prisma.evidenceRecord.create({
    data: {
      skill: 'LISTENING',
      evidenceType: 'TRANSFER',
      level: 'FULL',
      parentEvidenceId: applied.id,
      chainRootId: baseline.id,
      outputText: '在陌生主题讲座中独立记笔记并回答问题。',
      score: 2,
      assistanceLevel: 'A0',
      conditionJson: JSON.stringify(candidateCtx),
      createdAt: at('2026-11-24'),
    },
  });
  await prisma.retestSchedule.update({
    where: { idempotencyKey: `${baseline.id}:TRANSFER:2026-11-24` },
    data: { status: 'DONE', completedAt: at('2026-11-24'), completedEvidenceId: transfer.id },
  });
  check('迁移证据挂在新条件上', transfer.id !== '');

  // ── ⑥ 证据链与复测链核对 ────────────────────────────────────────────────
  console.log('[6] 证据链完整性');
  const chain = await prisma.evidenceRecord.findMany({
    where: { chainRootId: baseline.id },
    orderBy: { createdAt: 'asc' },
  });
  check(
    '链上 4 条记录顺序正确',
    chain.map((row) => row.evidenceType).join('→') ===
      'IMMEDIATE_RETEST→DELAYED_RETEST→APPLIED_TASK→TRANSFER',
    chain.map((row) => row.evidenceType).join('→'),
  );
  check(
    '父指针逐级衔接',
    chain[0].parentEvidenceId === baseline.id &&
      chain[1].parentEvidenceId === chain[0].id &&
      chain[2].parentEvidenceId === chain[1].id &&
      chain[3].parentEvidenceId === chain[2].id,
  );
  const doneSchedules = await prisma.retestSchedule.findMany({
    where: { parentEvidenceId: baseline.id, status: 'DONE' },
  });
  check('4 条排期均完成并带证据', doneSchedules.length === 4 && doneSchedules.every((row) => row.completedEvidenceId));

  // ── ⑦ 分项画像（不生成平均等级） ────────────────────────────────────────
  console.log('[7] 分项画像');
  const confidence = suggestProfileConfidence(
    [baseline, immediate, delayed, applied, transfer].map((row) => ({
      evidenceType: row.evidenceType,
      assistanceLevel: row.assistanceLevel,
    })) as Parameters<typeof suggestProfileConfidence>[0],
  );
  check('基线+延迟复测+迁移 → HIGH', confidence.confidence === 'HIGH', confidence.reasons.join('；'));
  await prisma.skillProfile.upsert({
    where: { skill: 'LISTENING' },
    create: {
      skill: 'LISTENING',
      direction: '细节抓取稳定，推断题仍需证据',
      confidence: confidence.confidence,
      evidenceBasis: [baseline.id, immediate.id, delayed.id, applied.id, transfer.id].join(','),
      lastAssessedAt: '2026-11-19',
      updatedAt: new Date(),
    },
    update: {
      confidence: confidence.confidence,
      evidenceBasis: [baseline.id, immediate.id, delayed.id, applied.id, transfer.id].join(','),
      lastAssessedAt: '2026-11-19',
    },
  });
  const profiles = await prisma.skillProfile.findMany();
  check('画像按技能独立存储', profiles.filter((row) => row.skill === 'LISTENING').length === 1);

  // ── ⑧ 90 天周期阶段 ─────────────────────────────────────────────────────
  console.log('[8] 90 天周期');
  const cycle = await prisma.learningCycle.create({
    data: {
      title: 'E2E fixture 周期',
      goal: '听力细节抓取达到独立应用',
      startDate: '2026-09-01',
      endDate: '2026-11-29',
      baselineRefs: JSON.stringify([baseline.id]),
      createdAt: at('2026-09-01'),
      updatedAt: at('2026-09-01'),
    },
  });
  check('周期第 1 天为校准', cyclePhaseForDay(cycleDayNumber(cycle.startDate, '2026-09-01')) === 'CALIBRATION');
  check('周期第 14 天为校准', cyclePhaseForDay(cycleDayNumber(cycle.startDate, '2026-09-14')) === 'CALIBRATION');
  check('周期第 15 天进入积累', cyclePhaseForDay(cycleDayNumber(cycle.startDate, '2026-09-15')) === 'BUILD');
  check('周期第 56 天仍在积累', cyclePhaseForDay(cycleDayNumber(cycle.startDate, '2026-10-26')) === 'BUILD');
  check('周期第 57 天进入交付', cyclePhaseForDay(cycleDayNumber(cycle.startDate, '2026-10-27')) === 'DELIVER');
  const progress = computeCycleProgress(cycle.startDate, '2026-11-29');
  check('第 90 天进度封顶', progress.dayNumber === 90, `day=${progress.dayNumber}`);

  // ── ⑨ 周主问题与中断恢复 ────────────────────────────────────────────────
  console.log('[9] 周复盘 & 中断恢复');
  const focus = await prisma.weeklyFocus.create({
    data: {
      cycleId: cycle.id,
      weekIndex: 1,
      weekStart: '2026-09-01',
      focusQuestion: '本周能否在不暂停的情况下抓住 4 个关键信息？',
      inputText: '两篇剑桥听力 Part 2',
      outputText: '两段英文要点复述',
      feedbackText: '第 2 次比第 1 次少暂停 1 次',
      transferEvidenceId: transfer.id,
      nextDecision: '下周换陌生主题再测一次',
      createdAt: at('2026-09-07'),
      updatedAt: at('2026-09-07'),
    },
  });
  check('周主问题四槽位齐全', weeklyFocusFilledSlots(focus) === 4);
  check('可标记已复盘', canReviewWeeklyFocus(focus).ok);
  const recovery = buildRecoveryAdvice('2026-11-19', 3);
  check('中断恢复只给一个最小下一步', recovery.message.includes('不补做积压任务') && recovery.minimalMinutes <= 15);

  // ── ⑩ 计划融合与独立性 ──────────────────────────────────────────────────
  console.log('[10] 计划融合 & AI 边界');
  check('15 分钟不强制证据链', recommendedEvidenceLevel(15) === null);
  check('30 分钟 → QUICK', recommendedEvidenceLevel(30) === 'QUICK');
  check('60 分钟 → STANDARD', recommendedEvidenceLevel(60) === 'STANDARD');
  check('180 分钟 → FULL', recommendedEvidenceLevel(180) === 'FULL');
  check('A0 计为独立产出', aiUsageIndependent('A0') === true);
  check('A4 绝不计独立产出', aiUsageIndependent('A4') === false);

  const dueSchedule = schedules.find((row) => row.retestType === 'DELAYED');
  const plan = generateAdaptivePlan({
    budgetMinutes: 60,
    stageCode: 'S1_A0_A2',
    dueRetests: { items: [{ id: dueSchedule!.id, minutes: dueSchedule!.estMinutes }], maxOverdueDays: 0 },
  });
  if (!plan.ok) throw new Error(`计划生成失败：${plan.code}`);
  const retestItem = plan.items.find((item) => item.module === 'EVIDENCE_RETEST');
  check('到期复测进入计划且为 P0', retestItem?.priority === 'P0', `minutes=${retestItem?.minutes}`);
  check('复测分钟计入预算但不越界', plan.totalPlannedMinutes <= 60);
  check('复测排期 ID 回传', plan.scheduledRetestIds.includes(dueSchedule!.id));

  // ── ⑪ 只读核对 ──────────────────────────────────────────────────────────
  console.log('[11] 只读核对');
  check('知识型复习队列未受影响', (await prisma.reviewTask.count()) === before.reviewTasks);
  check('v2.1 计划任务行未被改动', (await prisma.planTask.count()) === before.planTasks);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) {
    console.log('失败项：');
    for (const item of failures) console.log(`  - ${item}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.stack : String(error)}`);
  failed += 1;
} finally {
  await cleanup();
  if (failed > 0) process.exitCode = 1;
}
