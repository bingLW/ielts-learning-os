/**
 * 词汇只读查询（T26）。
 *
 * 三档掌握度**各自独立统计**：页面、图表、导出都是三个数并列，
 * 不提供「已掌握 42/60」这种合并口径。
 */

import type { Prisma } from '@prisma/client';
import {
  MASTERY_LABEL_ZH,
  MASTERY_LEVELS,
  MASTERY_WEIGHT,
  PAGE_SIZE,
  QUIZ_SIZE,
  VOCAB_NEW_DEFAULT,
} from '@/lib/constants';
import { resolveBusinessDate } from '@/lib/businessTime';
import { addDays, startOfIsoWeek } from '@/lib/date';
import { suggestNewWordCount } from '@/lib/domain/vocab';
import { prisma } from '@/lib/prisma';
import type {
  MasteryLevel,
  VocabQuizDto,
  VocabStatsDto,
  VocabWordRowDto,
} from '@/lib/types';

/** 列表筛选。 */
export interface VocabFilter {
  q?: string;
  mastery?: MasteryLevel | 'ALL';
  source?: string;
  onlyNew?: boolean;
}

function toWordDto(row: {
  id: string;
  word: string;
  phonetic: string | null;
  partOfSpeech: string | null;
  meaningZh: string;
  meaningEn: string | null;
  collocation: string | null;
  exampleSentence: string | null;
  source: string;
  learnedDate: string;
  mastery: string;
  lastReviewAt: string | null;
  nextReviewAt: string | null;
  isNew: boolean;
}): VocabWordRowDto {
  const mastery = row.mastery as MasteryLevel;
  return {
    id: row.id,
    word: row.word,
    phonetic: row.phonetic,
    partOfSpeech: row.partOfSpeech,
    meaningZh: row.meaningZh,
    meaningEn: row.meaningEn,
    collocation: row.collocation,
    exampleSentence: row.exampleSentence,
    source: row.source,
    learnedDate: row.learnedDate,
    mastery,
    masteryLabel: MASTERY_LABEL_ZH[mastery] ?? row.mastery,
    lastReviewAt: row.lastReviewAt,
    nextReviewAt: row.nextReviewAt,
    isNew: row.isNew,
  };
}

/** 单词列表。 */
export async function listVocabWords(filter: VocabFilter = {}): Promise<VocabWordRowDto[]> {
  const where: Prisma.VocabWordWhereInput = { archivedAt: null };
  if (filter.mastery && filter.mastery !== 'ALL') where.mastery = filter.mastery;
  if (filter.source) where.source = filter.source;
  if (filter.onlyNew) where.isNew = true;
  if (filter.q && filter.q.trim().length > 0) {
    const q = filter.q.trim();
    where.OR = [
      { word: { contains: q } },
      { meaningZh: { contains: q } },
      { collocation: { contains: q } },
    ];
  }

  const rows = await prisma.vocabWord.findMany({
    where,
    orderBy: [{ learnedDate: 'desc' }, { word: 'asc' }],
    take: PAGE_SIZE * 4,
  });
  return rows.map(toWordDto);
}

/** 词汇页统计 + 下周新词量建议。 */
export async function getVocabStats(nowDateParam?: string): Promise<VocabStatsDto> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const weekStart = startOfIsoWeek(nowDate);

  const [groups, newThisWeek, reviewDueToday, latestQuiz, quizCount] = await Promise.all([
    prisma.vocabWord.groupBy({
      by: ['mastery'],
      where: { archivedAt: null },
      _count: { _all: true },
    }),
    prisma.vocabWord.count({ where: { archivedAt: null, learnedDate: { gte: weekStart } } }),
    prisma.vocabWord.count({
      where: { archivedAt: null, nextReviewAt: { not: null, lte: nowDate } },
    }),
    prisma.vocabQuiz.findFirst({ orderBy: [{ quizDate: 'desc' }, { createdAt: 'desc' }] }),
    prisma.vocabQuiz.count(),
  ]);

  const counts = new Map<string, number>();
  for (const group of groups) counts.set(group.mastery, group._count._all);

  const recognizeOnly = counts.get('RECOGNIZE_ONLY') ?? 0;
  const comprehend = counts.get('COMPREHEND') ?? 0;
  const activeUse = counts.get('ACTIVE_USE') ?? 0;
  const quizAccuracy = latestQuiz?.weightedAccuracy ?? null;
  const suggestion = suggestNewWordCount(quizAccuracy, VOCAB_NEW_DEFAULT);

  return {
    total: recognizeOnly + comprehend + activeUse,
    recognizeOnly,
    comprehend,
    activeUse,
    newThisWeek,
    reviewDueToday,
    quizAccuracy,
    quizCount,
    suggestedNewWords: suggestion.next,
    suggestionReason: suggestion.reason,
  };
}

/**
 * 随机抽测候选。
 *
 * SQLite 没有 `ORDER BY RANDOM()` 的 Prisma 封装，因此在应用层洗牌；
 * 词表规模在本产品里是几千量级，这个代价可以接受。
 */
export async function pickQuizCandidates(size = QUIZ_SIZE.MIN): Promise<VocabWordRowDto[]> {
  const pool = await prisma.vocabWord.findMany({
    where: { archivedAt: null },
    orderBy: { learnedDate: 'asc' },
    take: 2000,
  });
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = temp;
  }
  const target = Math.min(size, Math.max(QUIZ_SIZE.MIN, Math.min(QUIZ_SIZE.MAX, size)));
  return shuffled.slice(0, Math.min(target, shuffled.length)).map(toWordDto);
}

/** 抽测历史（append-only，倒序）。 */
export async function listVocabQuizzes(limit = 12): Promise<VocabQuizDto[]> {
  const rows = await prisma.vocabQuiz.findMany({
    orderBy: [{ quizDate: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    include: { items: true },
  });

  return rows.map((row) => ({
    id: row.id,
    quizDate: row.quizDate,
    sampleSize: row.sampleSize,
    weightedAccuracy: row.weightedAccuracy,
    recommendation: row.recommendation,
    createdAt: row.createdAt.toISOString(),
    items: row.items.map((item) => ({
      id: item.id,
      wordId: item.wordId,
      word: item.word,
      selfRating: item.selfRating as MasteryLevel,
      weight: item.weight,
    })),
  }));
}

/** 三档权重表（抽测页展示用，避免页面自己写 0.3/0.7/1.0）。 */
export function masteryWeights(): { level: MasteryLevel; label: string; weight: number }[] {
  return MASTERY_LEVELS.map((level) => ({
    level,
    label: MASTERY_LABEL_ZH[level],
    weight: MASTERY_WEIGHT[level],
  }));
}

/** 今日是否已经抽测（避免同一天重复生成多条会话提示）。 */
export async function hasQuizToday(nowDateParam?: string): Promise<boolean> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const count = await prisma.vocabQuiz.count({ where: { quizDate: nowDate } });
  return count > 0;
}

/** 本周新增词数（按日）—— 供「词汇积累」图表使用。 */
export async function countVocabByDateRange(
  from: string,
  to: string,
): Promise<{ date: string; count: number }[]> {
  const rows = await prisma.vocabWord.findMany({
    where: { archivedAt: null, learnedDate: { gte: from, lte: to } },
    select: { learnedDate: true },
  });
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.learnedDate, (map.get(row.learnedDate) ?? 0) + 1);
  const out: { date: string; count: number }[] = [];
  let cursor = from;
  while (cursor <= to) {
    out.push({ date: cursor, count: map.get(cursor) ?? 0 });
    cursor = addDays(cursor, 1);
  }
  return out;
}
