/**
 * 薄弱点聚合查询（供 AI「薄弱项分析」建议使用）。
 *
 * 从 `getDashboard` 的薄弱点聚合逻辑抽取而来，但**独立查询**、互不干扰：
 * 排序唯一入口仍是 `domain/weakness.ts` 的 `rankWeaknesses`（口径唯一），
 * 这里只负责装配候选原始计数。
 */

import { SKILL_LABEL_ZH, WEAKNESS_MIN_QUESTIONS, WEAKNESS_TOP_N, WEAKNESS_WINDOW_DAYS } from '@/lib/constants';
import { resolveBusinessDate } from '@/lib/businessTime';
import { addDays, diffDays } from '@/lib/date';
import { mergeSampleTotals } from '@/lib/domain/accuracy';
import { rankWeaknesses, type WeaknessCandidate } from '@/lib/domain/weakness';
import { prisma } from '@/lib/prisma';
import type { SkillId, WeaknessDto } from '@/lib/types';

const DAY_MS = 86_400_000;

export interface WeaknessRanking {
  ranked: WeaknessDto[];
  insufficient: WeaknessDto[];
}

/** 聚合近 28 天的薄弱点排序结果。 */
export async function getWeaknessRanking(nowDateParam?: string): Promise<WeaknessRanking> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const fromWindow = addDays(nowDate, -(WEAKNESS_WINDOW_DAYS - 1));

  const [windowRecords, windowTasks, windowMistakes, lessons, pendingReviews] = await Promise.all([
    prisma.studyRecord.findMany({
      where: { archivedAt: null, recordDate: { gte: fromWindow, lte: nowDate } },
      select: { skill: true, totalQuestions: true, correctQuestions: true },
    }),
    prisma.planTask.findMany({
      where: { planDate: { gte: fromWindow, lte: nowDate } },
      select: { skill: true, plannedMinutes: true, actualMinutes: true },
    }),
    prisma.mistake.findMany({
      where: { archivedAt: null, createdAt: { gte: new Date(Date.now() - WEAKNESS_WINDOW_DAYS * DAY_MS) } },
      select: {
        knowledgePoint: true,
        errorCategory: true,
        studyRecord: { select: { totalQuestions: true } },
      },
    }),
    prisma.egiuLesson.findMany({
      where: { archivedAt: null },
      select: { currentColor: true, knowledgePoint: true },
    }),
    prisma.reviewTask.findMany({
      where: { status: 'PENDING' },
      select: { dueDate: true, knowledgePoint: true },
    }),
  ]);

  const subjectTotals = mergeSampleTotals(
    windowRecords.map((record) => ({
      total: record.totalQuestions,
      correct: record.correctQuestions,
    })),
  );

  const skillAgg = new Map<string, { total: number; correct: number; planned: number; actual: number }>();
  for (const record of windowRecords) {
    const entry = skillAgg.get(record.skill) ?? { total: 0, correct: 0, planned: 0, actual: 0 };
    entry.total += record.totalQuestions;
    entry.correct += Math.min(record.correctQuestions, record.totalQuestions);
    skillAgg.set(record.skill, entry);
  }
  for (const task of windowTasks) {
    const entry = skillAgg.get(task.skill) ?? { total: 0, correct: 0, planned: 0, actual: 0 };
    entry.planned += task.plannedMinutes;
    entry.actual += task.actualMinutes;
    skillAgg.set(task.skill, entry);
  }

  const knowledgeAgg = new Map<
    string,
    { wrong: number; sampleTotal: number; categories: Map<string, number> }
  >();
  for (const mistake of windowMistakes) {
    const entry =
      knowledgeAgg.get(mistake.knowledgePoint) ?? { wrong: 0, sampleTotal: 0, categories: new Map<string, number>() };
    entry.wrong += 1;
    entry.sampleTotal += Math.max(1, mistake.studyRecord?.totalQuestions ?? 1);
    entry.categories.set(
      mistake.errorCategory,
      (entry.categories.get(mistake.errorCategory) ?? 0) + 1,
    );
    knowledgeAgg.set(mistake.knowledgePoint, entry);
  }

  const reviewDebtByPoint = new Map<string, { total: number; overdue: number }>();
  for (const task of pendingReviews) {
    if (!task.knowledgePoint) continue;
    const entry = reviewDebtByPoint.get(task.knowledgePoint) ?? { total: 0, overdue: 0 };
    entry.total += 1;
    if (diffDays(task.dueDate, nowDate) > 0) entry.overdue += 1;
    reviewDebtByPoint.set(task.knowledgePoint, entry);
  }

  const redByPoint = new Map<string, number>();
  for (const lesson of lessons) {
    if (lesson.currentColor !== 'RED') continue;
    redByPoint.set(lesson.knowledgePoint, (redByPoint.get(lesson.knowledgePoint) ?? 0) + 1);
  }

  const candidates: WeaknessCandidate[] = [];

  for (const [skill, agg] of skillAgg.entries()) {
    if (agg.total === 0 && agg.planned === 0) continue;
    candidates.push({
      key: `SKILL:${skill}`,
      name: `${SKILL_LABEL_ZH[skill as SkillId] ?? skill}整体`,
      scope: 'SKILL',
      totalQuestions: agg.total,
      wrongQuestions: agg.total - agg.correct,
      subjectAcc: subjectTotals.accuracy,
      dimAcc: agg.total > 0 ? agg.correct / agg.total : null,
      plannedMinutes: agg.planned,
      actualMinutes: agg.actual,
      reviewTotal: 0,
      reviewOverdue: 0,
      unitTotal: 0,
      unitRed: 0,
    });
  }

  for (const [point, agg] of knowledgeAgg.entries()) {
    const debt = reviewDebtByPoint.get(point) ?? { total: 0, overdue: 0 };
    const dominant = [...agg.categories.entries()].sort((a, b) => b[1] - a[1])[0];
    candidates.push({
      key: `POINT:${point}`,
      name: point,
      scope: 'KNOWLEDGE',
      totalQuestions: agg.sampleTotal,
      wrongQuestions: agg.wrong,
      subjectAcc: subjectTotals.accuracy,
      dimAcc: Math.max(0, (agg.sampleTotal - agg.wrong) / agg.sampleTotal),
      plannedMinutes: 0,
      actualMinutes: 0,
      reviewTotal: debt.total,
      reviewOverdue: debt.overdue,
      unitTotal: 1,
      unitRed: redByPoint.get(point) ?? 0,
      mainErrorCategory: dominant?.[0],
    });
  }

  return rankWeaknesses(candidates, {
    minQuestions: WEAKNESS_MIN_QUESTIONS,
    limit: WEAKNESS_TOP_N,
  });
}
