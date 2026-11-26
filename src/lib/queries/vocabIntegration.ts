/**
 * v2.3 词汇集成只读查询。
 *
 * 所有「掌握」相关数字都按维度分开返回；这里没有「已掌握总数」这种字段。
 */

import { VOCAB_DIMENSIONS } from '@/lib/constants';
import type { VocabDimension, VocabDimensionStatus, VocabPracticeMode, VocabSessionGranularity } from '@/lib/constants';
import { businessToday, getBusinessTimezone } from '@/lib/businessTime';
import { addDays, diffDays, endOfBusinessDay, toBusinessDate, toUtcInstant } from '@/lib/date';
import { parseJson, parseStringArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type {
  VocabAnalyticsDto,
  VocabAssignmentDto,
  VocabConnectionDto,
  VocabDeckDto,
  VocabIntegrationJobDto,
  VocabLibraryStatsDto,
  VocabPracticeSessionDto,
  VocabWordDetailDto,
} from '@/lib/types';
import type { VocabIntegrationMode } from '@/lib/constants';

export async function getVocabLibraryStats(): Promise<VocabLibraryStatsDto> {
  const timeZone = await getBusinessTimezone();
  const now = await businessToday();
  const yesterday = addDays(now, -1);

  const [items, decks, dueStates, introducedToday, lastSource, lastSession, verifiedGroups] =
    await Promise.all([
      prisma.vocabularyItem.count({ where: { archivedAt: null } }),
      prisma.vocabularyDeck.count({ where: { archivedAt: null } }),
      prisma.vocabularyKnowledgeState.count({
        where: {
          status: { in: ['INTRODUCED', 'RECOGNIZED', 'RECALLED'] },
          OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lte: yesterday } }],
        },
      }),
      prisma.vocabularyItem.count({ where: { archivedAt: null, createdAt: { gte: toUtcInstant(now, '00:00', timeZone) } } }),
      prisma.vocabularySource.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.vocabularyPracticeSession.findFirst({ orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
      prisma.vocabularyKnowledgeState.groupBy({
        by: ['dimension'],
        where: { status: { in: ['RECALLED', 'CONTEXT_UNDERSTOOD', 'PRODUCTIVE_USE_VERIFIED'] } },
        _count: { _all: true },
      }),
    ]);

  const dimensionVerified = Object.fromEntries(
    VOCAB_DIMENSIONS.map((dimension) => [dimension, 0]),
  ) as Record<VocabDimension, number>;
  for (const group of verifiedGroups) {
    if (group.dimension in dimensionVerified) {
      dimensionVerified[group.dimension as VocabDimension] = group._count._all;
    }
  }

  return {
    items,
    decks,
    dueReview: dueStates,
    introducedToday,
    dimensionVerified,
    lastImportAt: lastSource?.createdAt.toISOString() ?? null,
    lastSessionAt: lastSession?.startedAt.toISOString() ?? null,
  };
}

export interface VocabDashboardSummary {
  items: number;
  dueReview: number;
  introducedToday: number;
  retestPending: number;
  retestDue: number;
  assignment: { reviewTarget: number; newTarget: number; status: string } | null;
  lastSessionAt: string | null;
}

/** Dashboard 词汇卡片：只取五个数，不把七维压成「已掌握」。 */
export async function getVocabDashboardSummary(): Promise<VocabDashboardSummary> {
  const timeZone = await getBusinessTimezone();
  const date = await businessToday();
  const [items, dueReview, introducedToday, retestPending, retestDue, assignment, lastSession] =
    await Promise.all([
      prisma.vocabularyItem.count({ where: { archivedAt: null } }),
      prisma.vocabularyKnowledgeState.count({
        where: {
          status: { in: ['INTRODUCED', 'RECOGNIZED', 'RECALLED'] },
          OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lte: addDays(date, -1) } }],
        },
      }),
      prisma.vocabularyItem.count({
        where: { archivedAt: null, createdAt: { gte: toUtcInstant(date, '00:00', timeZone) } },
      }),
      prisma.retestSchedule.count({
        where: { note: { startsWith: 'VOCAB|' }, status: 'PENDING' },
      }),
      prisma.retestSchedule.count({
        where: { note: { startsWith: 'VOCAB|' }, status: 'PENDING', dueDate: { lte: date } },
      }),
      prisma.vocabularyAssignment.findUnique({
        where: { assignmentDate: date },
        select: { reviewTarget: true, newTarget: true, status: true },
      }),
      prisma.vocabularyPracticeSession.findFirst({
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
    ]);

  return {
    items,
    dueReview,
    introducedToday,
    retestPending,
    retestDue,
    assignment,
    lastSessionAt: lastSession?.startedAt.toISOString() ?? null,
  };
}

export interface VocabRetestSummary {
  pending: number;
  due: number;
  completedInRange: number;
  upcoming: Array<{ dueDate: string; status: string; dimension: string }>;
}

/** 词汇延迟复测统计：待办 / 到期 / 区间内完成 + 最近 10 条排期。 */
export async function getVocabRetestSummary(from: string, to: string): Promise<VocabRetestSummary> {
  const timeZone = await getBusinessTimezone();
  const date = await businessToday();
  const vocabOnly = { note: { startsWith: 'VOCAB|' } };
  const [pending, due, completedInRange, upcoming] = await Promise.all([
    prisma.retestSchedule.count({ where: { ...vocabOnly, status: 'PENDING' } }),
    prisma.retestSchedule.count({
      where: { ...vocabOnly, status: 'PENDING', dueDate: { lte: date } },
    }),
    prisma.retestSchedule.count({
      where: {
        ...vocabOnly,
        status: 'DONE',
        completedAt: {
          gte: toUtcInstant(from, '00:00', timeZone),
          lt: endOfBusinessDay(to, timeZone),
        },
      },
    }),
    prisma.retestSchedule.findMany({
      where: vocabOnly,
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
      take: 10,
      select: { dueDate: true, status: true, note: true },
    }),
  ]);

  return {
    pending,
    due,
    completedInRange,
    upcoming: upcoming.map((row) => ({
      dueDate: row.dueDate,
      status: row.status,
      dimension: (row.note ?? '').split('|')[2] ?? '',
    })),
  };
}

export async function listVocabDecks(): Promise<VocabDeckDto[]> {
  const decks = await prisma.vocabularyDeck.findMany({
    where: { archivedAt: null },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { items: true } } },
  });
  return decks.map((deck) => ({
    id: deck.id,
    title: deck.title,
    targetStage: deck.targetStage,
    version: deck.version,
    dailyNewTarget: deck.dailyNewTarget,
    reviewCap: deck.reviewCap,
    status: deck.status,
    itemCount: deck._count.items,
    externalDeckId: deck.externalDeckId,
    lastSyncedAt: deck.lastSyncedAt?.toISOString() ?? null,
    note: deck.note,
  }));
}

export async function getActiveVocabDeck(): Promise<VocabDeckDto | null> {
  const decks = await listVocabDecks();
  return decks.find((deck) => deck.status === 'ACTIVE') ?? decks[0] ?? null;
}

export async function getDeckItems(deckId: string, limit = 200) {
  const rows = await prisma.vocabularyDeckItem.findMany({
    where: { deckId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    take: limit,
    include: { item: true },
  });
  return rows.map((row) => ({
    itemId: row.itemId,
    lemma: row.item.lemma,
    pos: row.item.pos,
    definitionZh: row.item.definitionZh,
    phoneticUk: row.item.phoneticUk,
    tags: parseStringArray(row.item.tagsJson),
  }));
}

function toAssignmentDto(row: {
  id: string;
  assignmentDate: string;
  budgetMinutes: number;
  reviewTarget: number;
  newTarget: number;
  estimatedMinutes: number;
  status: string;
  rationale: string | null;
  deckId: string | null;
  planTaskId: string | null;
  externalDeckId: string | null;
  sentAt: Date | null;
  priorityPolicyJson: string | null;
  items: Array<{
    itemId: string;
    priority: string;
    kind: string;
    mode: string | null;
    item: { lemma: string; pos: string; definitionZh: string | null };
  }>;
  deck: { title: string } | null;
}): VocabAssignmentDto {
  return {
    id: row.id,
    assignmentDate: row.assignmentDate,
    budgetMinutes: row.budgetMinutes,
    reviewTarget: row.reviewTarget,
    newTarget: row.newTarget,
    estimatedMinutes: row.estimatedMinutes,
    status: row.status,
    rationale: row.rationale,
    deckId: row.deckId,
    deckTitle: row.deck?.title ?? null,
    planTaskId: row.planTaskId,
    externalDeckId: row.externalDeckId,
    sentAt: row.sentAt?.toISOString() ?? null,
    priorityPolicy: row.priorityPolicyJson ? parseJson<Record<string, unknown>>(row.priorityPolicyJson, {}) : null,
    items: row.items
      .slice()
      .sort((a, b) => (a.priority === b.priority ? 0 : a.priority.localeCompare(b.priority)))
      .map((item) => ({
        itemId: item.itemId,
        lemma: item.item.lemma,
        pos: item.item.pos,
        definitionZh: item.item.definitionZh,
        priority: item.priority as VocabAssignmentDto['items'][number]['priority'],
        kind: item.kind as 'REVIEW' | 'NEW' | 'WEAKNESS',
        mode: (item.mode as VocabPracticeMode | null) ?? null,
      })),
  };
}

export async function getVocabAssignment(date: string): Promise<VocabAssignmentDto | null> {
  const row = await prisma.vocabularyAssignment.findUnique({
    where: { assignmentDate: date },
    include: {
      items: { include: { item: { select: { lemma: true, pos: true, definitionZh: true } } } },
      deck: { select: { title: true } },
    },
  });
  return row ? toAssignmentDto(row) : null;
}

function toSessionDto(row: {
  id: string;
  externalSessionId: string;
  mode: string | null;
  granularity: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  effectiveSeconds: number | null;
  overlapAdjusted: boolean;
  correctCount: number | null;
  incorrectCount: number | null;
  studySessionId: string | null;
  importedAt: Date;
}): VocabPracticeSessionDto {
  return {
    id: row.id,
    externalSessionId: row.externalSessionId,
    mode: row.mode,
    granularity: row.granularity as VocabSessionGranularity,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    durationSeconds: row.durationSeconds,
    effectiveSeconds: row.effectiveSeconds ?? row.durationSeconds,
    overlapAdjusted: row.overlapAdjusted,
    correctCount: row.correctCount,
    incorrectCount: row.incorrectCount,
    studySessionId: row.studySessionId,
    importedAt: row.importedAt.toISOString(),
  };
}

export async function listRecentSessions(limit = 20): Promise<VocabPracticeSessionDto[]> {
  const rows = await prisma.vocabularyPracticeSession.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
  return rows.map(toSessionDto);
}

export async function listIntegrationJobs(limit = 20): Promise<VocabIntegrationJobDto[]> {
  const rows = await prisma.integrationJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    direction: row.direction,
    status: row.status,
    fileName: row.fileName,
    countsJson: row.countsJson,
    errorReport: row.errorReport,
    retryCount: row.retryCount,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

export async function listVocabConnections(): Promise<VocabConnectionDto[]> {
  const rows = await prisma.integrationConnection.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    name: row.name,
    mode: row.mode as VocabIntegrationMode,
    pinnedVersion: row.pinnedVersion,
    licenseNote: row.licenseNote,
    enabled: row.enabled,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
  }));
}

export async function getVocabWordDetail(itemId: string): Promise<VocabWordDetailDto | null> {
  const item = await prisma.vocabularyItem.findUnique({
    where: { id: itemId },
    include: {
      source: { select: { title: true, sourceType: true } },
      knowledge: true,
      evidenceLinks: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          evidence: {
            select: {
              id: true,
              evidenceType: true,
              level: true,
              score: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });
  if (!item) return null;
  const timeZone = await getBusinessTimezone();

  const dimensionMap = new Map(item.knowledge.map((state) => [state.dimension, state]));
  const dimensions = VOCAB_DIMENSIONS.map((dimension) => {
    const state = dimensionMap.get(dimension);
    return {
      dimension,
      status: (state?.status ?? 'UNKNOWN') as VocabDimensionStatus,
      confidence: state?.confidence ?? 'LOW',
      evidenceCount: state?.evidenceCount ?? 0,
      lastVerifiedAt: state?.lastVerifiedAt ?? null,
    };
  });

  const sessions = await prisma.vocabularyPracticeSession.findMany({
    where: { attempts: { some: { itemId } } },
    orderBy: { startedAt: 'desc' },
    take: 10,
  });

  return {
    id: item.id,
    lemma: item.lemma,
    pos: item.pos,
    senseKey: item.senseKey,
    definitionZh: item.definitionZh,
    definitionEn: item.definitionEn,
    phoneticUk: item.phoneticUk,
    phoneticUs: item.phoneticUs,
    examples: parseStringArray(item.examplesJson),
    collocations: parseStringArray(item.collocationsJson),
    tags: parseStringArray(item.tagsJson),
    sourceTitle: item.source?.title ?? null,
    sourceType: item.source?.sourceType ?? 'UNKNOWN',
    dimensions,
    recentSessions: sessions.map(toSessionDto),
    recentEvidence: item.evidenceLinks.map((link) => ({
      id: link.evidenceId,
      dimension: link.dimension as VocabDimension,
      evidenceType: link.evidence.evidenceType,
      level: link.evidence.level,
      score: link.evidence.score,
      businessDate: toBusinessDate(link.evidence.createdAt, timeZone),
    })),
  };
}

export interface VocabCandidateContext {
  deck: VocabDeckDto | null;
  reviews: Array<{ itemId: string; lemma: string; dueDate: string; overdueDays: number }>;
  weaknesses: Array<{ itemId: string; lemma: string }>;
  newItems: Array<{ itemId: string; lemma: string }>;
  dueReviewCount: number;
  availableNewCount: number;
  maxOverdueDays: number;
}

/** 供计划生成与「今日词汇」页共用的候选池（只读）。 */
export async function loadVocabCandidateContext(assignmentDate: string): Promise<VocabCandidateContext> {
  const deck = await getActiveVocabDeck();
  if (!deck) {
    return {
      deck: null,
      reviews: [],
      weaknesses: [],
      newItems: [],
      dueReviewCount: 0,
      availableNewCount: 0,
      maxOverdueDays: 0,
    };
  }

  const items = await prisma.vocabularyDeckItem.findMany({
    where: { deckId: deck.id },
    take: 3000,
    include: { item: { select: { id: true, lemma: true } } },
  });
  const itemIds = items.map((row) => row.itemId);
  const states = await prisma.vocabularyKnowledgeState.findMany({
    where: { itemId: { in: itemIds } },
  });
  const stateByItem = new Map<string, typeof states>();
  for (const state of states) {
    const list = stateByItem.get(state.itemId) ?? [];
    list.push(state);
    stateByItem.set(state.itemId, list);
  }

  const reviews: VocabCandidateContext['reviews'] = [];
  const weaknesses: VocabCandidateContext['weaknesses'] = [];
  const newItems: VocabCandidateContext['newItems'] = [];

  for (const row of items) {
    const itemStates = stateByItem.get(row.itemId) ?? [];
    const meaningState = itemStates.find((state) => state.dimension === 'MEANING_RECOGNITION');
    if (!meaningState || meaningState.status === 'UNKNOWN') {
      newItems.push({ itemId: row.itemId, lemma: row.item.lemma });
      continue;
    }
    if (meaningState.status === 'INTRODUCED' && meaningState.evidenceCount >= 2) {
      weaknesses.push({ itemId: row.itemId, lemma: row.item.lemma });
    }
    const verifiedDate = meaningState.lastVerifiedAt ?? assignmentDate;
    const overdueDays = Math.max(0, diffDays(verifiedDate, assignmentDate));
    if (overdueDays >= 3) {
      reviews.push({
        itemId: row.itemId,
        lemma: row.item.lemma,
        dueDate: addDays(verifiedDate, 3),
        overdueDays,
      });
    }
  }

  reviews.sort((a, b) => b.overdueDays - a.overdueDays);
  return {
    deck,
    reviews,
    weaknesses,
    newItems,
    dueReviewCount: reviews.length,
    availableNewCount: newItems.length,
    maxOverdueDays: reviews[0]?.overdueDays ?? 0,
  };
}

export async function getVocabAnalytics(from: string, to: string): Promise<VocabAnalyticsDto> {
  const timeZone = await getBusinessTimezone();
  const sessions = await prisma.vocabularyPracticeSession.findMany({
    where: {
      startedAt: {
        gte: toUtcInstant(from, '00:00', timeZone),
        lt: endOfBusinessDay(to, timeZone),
      },
    },
    orderBy: { startedAt: 'asc' },
  });

  const daily = new Map<string, { minutes: number; sessions: number; correct: number; incorrect: number }>();
  const modes = new Map<string, number>();
  for (const session of sessions) {
    const date = toBusinessDate(session.startedAt, timeZone);
    const entry = daily.get(date) ?? { minutes: 0, sessions: 0, correct: 0, incorrect: 0 };
    entry.minutes += Math.round((session.effectiveSeconds ?? session.durationSeconds) / 60);
    entry.sessions += 1;
    entry.correct += session.correctCount ?? 0;
    entry.incorrect += session.incorrectCount ?? 0;
    daily.set(date, entry);
    const mode = session.mode ?? 'MIXED';
    modes.set(mode, (modes.get(mode) ?? 0) + Math.round((session.effectiveSeconds ?? session.durationSeconds) / 60));
  }

  const newWords = await prisma.vocabularyItem.findMany({
    where: {
      createdAt: {
        gte: toUtcInstant(from, '00:00', timeZone),
        lt: endOfBusinessDay(to, timeZone),
      },
    },
    select: { createdAt: true },
  });
  const newPerDay = new Map<string, number>();
  for (const item of newWords) {
    const date = toBusinessDate(item.createdAt, timeZone);
    newPerDay.set(date, (newPerDay.get(date) ?? 0) + 1);
  }

  const dimensionGroups = await prisma.vocabularyKnowledgeState.groupBy({
    by: ['dimension', 'status'],
    _count: { _all: true },
  });
  const dimensionCoverage = VOCAB_DIMENSIONS.map((dimension) => {
    const verified = dimensionGroups
      .filter(
        (group) =>
          group.dimension === dimension &&
          ['RECALLED', 'CONTEXT_UNDERSTOOD', 'PRODUCTIVE_USE_VERIFIED'].includes(group.status),
      )
      .reduce((sum, group) => sum + group._count._all, 0);
    const introduced = dimensionGroups
      .filter((group) => group.dimension === dimension && group.status === 'INTRODUCED')
      .reduce((sum, group) => sum + group._count._all, 0);
    return { dimension, verified, introduced };
  });

  const assignments = await prisma.vocabularyAssignment.findMany({
    where: { assignmentDate: { gte: from, lte: to } },
    select: { assignmentDate: true, estimatedMinutes: true },
  });

  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }

  return {
    range: { from, to },
    dailyMinutes: dates.map((date) => ({
      date,
      minutes: daily.get(date)?.minutes ?? 0,
      sessions: daily.get(date)?.sessions ?? 0,
    })),
    modeMinutes: [...modes.entries()].map(([mode, minutes]) => ({
      mode: mode as VocabPracticeMode,
      minutes,
    })),
    newPerDay: dates.map((date) => ({ date, count: newPerDay.get(date) ?? 0 })),
    dimensionCoverage,
    accuracyTrend: dates.map((date) => ({
      date,
      correct: daily.get(date)?.correct ?? 0,
      incorrect: daily.get(date)?.incorrect ?? 0,
    })),
    planningVsActual: dates.map((date) => ({
      date,
      planned: assignments.find((row) => row.assignmentDate === date)?.estimatedMinutes ?? 0,
      actual: daily.get(date)?.minutes ?? 0,
    })),
  };
}
