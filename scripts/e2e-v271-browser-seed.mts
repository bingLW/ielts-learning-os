import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { addDays } from '../src/lib/date.ts';
import { seedDatabase } from '../prisma/seed.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !databaseUrl.startsWith('file:/tmp/ielts-browser-')) {
  throw new Error('DATABASE_URL 必须指向 /tmp/ielts-browser-* 隔离库');
}
if (process.cwd() !== resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  throw new Error('必须在仓库根目录运行');
}

const prisma = new PrismaClient();
const asOfDate = process.env.AS_OF_DATE ?? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

try {
  await seedDatabase(prisma);
  await prisma.planTask.deleteMany();
  await prisma.planVersion.deleteMany();
  await prisma.planningSnapshot.deleteMany();
  await prisma.egiuLesson.deleteMany();
  await prisma.reviewTask.deleteMany();
  await prisma.learningGoal.deleteMany();
  const stage = await prisma.stage.upsert({
    where: { code: 'S3_B1_IELTS' },
    update: { status: 'ACTIVE', profileCode: 'B1_B2' },
    create: { code: 'S3_B1_IELTS', nameZh: '浏览器验收阶段', estDaysMin: 30, status: 'ACTIVE', profileCode: 'B1_B2' },
  });
  const stageId = stage.id;
  await prisma.skillAllocationProfile.updateMany({ where: { profileCode: 'B1_B2' }, data: { isActive: true } });
  await prisma.plannerSettings.upsert({
    where: { id: 1 },
    update: { defaultDailyMinutes: 100, minTaskMinutes: 5, isUserConfirmed: true },
    create: { id: 1, defaultDailyMinutes: 100, minTaskMinutes: 5, isUserConfirmed: true },
  });
  await prisma.dailyBudget.upsert({
    where: { date: asOfDate },
    update: { plannedAvailableMinutes: 100, isRestDay: false, source: 'USER' },
    create: { date: asOfDate, plannedAvailableMinutes: 100, isRestDay: false, source: 'USER' },
  });
  await prisma.learningGoal.create({ data: { goalType: 'GENERAL_ENGLISH', name: '通用英语', status: 'ACTIVE', targetValue: 'B2' } });
  await prisma.evidenceRecord.create({ data: { skill: 'READING', evidenceType: 'BASELINE', level: 'QUICK', assistanceLevel: 'A0', score: 2, confidence: 'MEDIUM' } });
  await prisma.planningSnapshot.create({
    data: {
      id: 'snapshot-browser-carryover', purpose: 'GENERATE', asOfDate, inputHash: 'browser-fixture', ruleVersion: 'v2.7.0',
      budgetJson: JSON.stringify({ budgetMinutes: 100, source: 'USER' }), configJson: JSON.stringify({ minTaskMinutes: 5 }),
      validationJson: JSON.stringify({ ok: true, stale: [], missingBaseline: [], lowConfidence: [] }),
    },
  });
  await prisma.egiuLesson.createMany({
    data: Array.from({ length: 5 }, (_, index) => ({
      id: `egiu-browser-${index + 1}`, stageId, unitNo: String(index + 1), knowledgePoint: `语法点 ${index + 1}`,
      learnedDate: '2026-01-01', currentColor: 'YELLOW', nextReviewDate: asOfDate,
    })),
  });
  await prisma.reviewTask.create({
    data: { id: 'review-browser', targetType: 'VOCAB_WORD', targetId: 'word-browser', targetLabel: '词汇复习', intervalCode: 'D1', dueDate: asOfDate, status: 'PENDING', estMinutes: 5 },
  });
  const overdue = [
    { id: 'browser-promote', date: addDays(asOfDate, -3), minutes: 30, actual: 20, priority: 'P0', movedCount: 0, splittable: true },
    { id: 'browser-demote', date: addDays(asOfDate, -6), minutes: 5, actual: 0, priority: 'P0', movedCount: 0, splittable: true },
    { id: 'browser-backlog', date: addDays(asOfDate, -2), minutes: 10, actual: 0, priority: 'P1', movedCount: 0, splittable: false },
    { id: 'browser-abandon', date: addDays(asOfDate, -2), minutes: 10, actual: 0, priority: 'P3', movedCount: 2, splittable: true },
  ];
  for (const [index, task] of overdue.entries()) {
    await prisma.planTask.create({
      data: {
        id: task.id, stageId, planDate: task.date, module: index === 0 ? 'LISTENING' : 'READING',
        skill: index === 0 ? 'LISTENING' : 'READING', primarySkill: index === 0 ? 'LISTENING' : 'READING',
        plannedMinutes: task.minutes, actualMinutes: task.actual, status: 'MISSED', priority: task.priority,
        sourceKind: 'CORE', splittable: task.splittable, minChunkMinutes: 5, movedCount: task.movedCount,
        originalScheduledDate: task.date, sortOrder: index, planVersion: 1, timerStatus: 'IDLE',
      },
    });
  }
  console.log(JSON.stringify({ ok: true, database: databaseUrl, asOfDate, stageId }));
} finally {
  await prisma.$disconnect();
}
