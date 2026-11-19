/**
 * 各模块概览计数。
 *
 * 阶段 C/D 的页面（语法诊断 / 错题 / 词汇 / 句子 / 复盘）本轮只做到「真实数据 + 空态引导」，
 * 用一个聚合查询给出每页顶部的真实计数，避免占位页出现任何假数字。
 */

import { colorDistribution } from '@/lib/domain/review';
import { parseStringArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type { ColorDistributionDto, EgiuColor, MasteryLevel } from '@/lib/types';

export interface ModuleOverview {
  egiuTotal: number;
  egiuColors: ColorDistributionDto;
  reviewPending: number;
  reviewOverdue: number;
  mistakeTotal: number;
  mistakeMastered: number;
  vocabTotal: number;
  vocabNew: number;
  mastery: { RECOGNIZE_ONLY: number; COMPREHEND: number; ACTIVE_USE: number };
  sentenceTotal: number;
  sentencePatterns: string[];
  weeklyReviewTotal: number;
  grammerReviewCount: number;
}

export async function getModuleOverview(nowDate: string): Promise<ModuleOverview> {
  const [
    lessons,
    pendingReviews,
    mistakes,
    mistakeMastered,
    vocabTotal,
    vocabNew,
    vocabByMastery,
    sentenceTotal,
    sentences,
    weeklyReviewTotal,
    reviewRows,
  ] = await Promise.all([
    prisma.egiuLesson.findMany({ where: { archivedAt: null }, select: { currentColor: true } }),
    prisma.reviewTask.findMany({
      where: { status: 'PENDING' },
      select: { dueDate: true, intervalCode: true },
    }),
    prisma.mistake.count({ where: { archivedAt: null } }),
    prisma.mistake.count({ where: { archivedAt: null, isMastered: true } }),
    prisma.vocabWord.count({ where: { archivedAt: null } }),
    prisma.vocabWord.count({ where: { archivedAt: null, isNew: true } }),
    prisma.vocabWord.groupBy({
      by: ['mastery'],
      where: { archivedAt: null },
      _count: { _all: true },
    }),
    prisma.sentenceAnalysis.count({ where: { archivedAt: null } }),
    prisma.sentenceAnalysis.findMany({
      where: { archivedAt: null },
      select: { patternTag: true },
    }),
    prisma.weeklyReview.count(),
    prisma.egiuReview.count(),
  ]);

  const mastery = { RECOGNIZE_ONLY: 0, COMPREHEND: 0, ACTIVE_USE: 0 };
  for (const row of vocabByMastery) {
    const level = row.mastery as MasteryLevel;
    if (level === 'RECOGNIZE_ONLY' || level === 'COMPREHEND' || level === 'ACTIVE_USE') {
      mastery[level] = row._count._all;
    }
  }

  const patterns = new Set<string>();
  for (const sentence of sentences) {
    if (sentence.patternTag) patterns.add(sentence.patternTag);
  }

  return {
    egiuTotal: lessons.length,
    egiuColors: colorDistribution(lessons.map((lesson) => ({ color: lesson.currentColor as EgiuColor }))),
    reviewPending: pendingReviews.length,
    reviewOverdue: pendingReviews.filter((task) => task.dueDate < nowDate).length,
    mistakeTotal: mistakes,
    mistakeMastered,
    vocabTotal,
    vocabNew,
    mastery,
    sentenceTotal,
    sentencePatterns: [...patterns],
    weeklyReviewTotal,
    grammerReviewCount: reviewRows,
  };
}

/** 解析 JSON 数组字段的便捷包装（供页面层复用）。 */
export function parseTags(raw: string | null): string[] {
  return parseStringArray(raw);
}
