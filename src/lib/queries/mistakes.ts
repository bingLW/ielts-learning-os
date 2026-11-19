/**
 * 错题本只读查询（T25）。
 */

import type { Prisma } from '@prisma/client';
import {
  ERROR_CATEGORIES,
  ERROR_CATEGORY_LABEL_ZH,
  IELTS_ERROR_CATEGORY_LABEL_ZH,
  MISTAKE_SOURCE_LABEL_ZH,
  MISTAKE_TOP_KNOWLEDGE_POINTS,
  PAGE_SIZE,
} from '@/lib/constants';
import { endOfBusinessDay, toUtcInstant } from '@/lib/date';
import { prisma } from '@/lib/prisma';
import type {
  ErrorCategory,
  IeltsErrorCategory,
  MistakeFilterState,
  MistakeRowDto,
  MistakeSource,
  MistakeStatsDto,
} from '@/lib/types';

/** 空筛选态（页面 URL 没有参数时用）。 */
export function emptyMistakeFilter(): MistakeFilterState {
  return {
    q: '',
    errorCategory: 'ALL',
    knowledgePoint: '',
    mastery: 'ALL',
    from: '',
    to: '',
    stageId: '',
  };
}

/** 错题列表（默认只看未掌握；筛选全部在服务端完成）。 */
export async function listMistakes(filter: MistakeFilterState): Promise<MistakeRowDto[]> {
  const where: Prisma.MistakeWhereInput = { archivedAt: null };
  if (filter.stageId) where.stageId = filter.stageId;
  if (filter.errorCategory !== 'ALL') where.errorCategory = filter.errorCategory;
  if (filter.mastery === 'MASTERED') where.isMastered = true;
  if (filter.mastery === 'UNMASTERED') where.isMastered = false;
  if (filter.knowledgePoint) where.knowledgePoint = filter.knowledgePoint;
  if (filter.from || filter.to) {
    // 业务日期 → 真实时刻：统一走 date lib，不手写 +08:00 偏移字符串
    where.createdAt = {
      ...(filter.from ? { gte: toUtcInstant(filter.from) } : {}),
      ...(filter.to ? { lte: endOfBusinessDay(filter.to) } : {}),
    };
  }
  if (filter.q.trim().length > 0) {
    const q = filter.q.trim();
    where.OR = [
      { originalQuestion: { contains: q } },
      { knowledgePoint: { contains: q } },
      { errorReason: { contains: q } },
      { correctAnswer: { contains: q } },
    ];
  }

  const rows = await prisma.mistake.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }],
    take: PAGE_SIZE * 4,
  });

  return rows.map((row) => ({
    id: row.id,
    stageId: row.stageId,
    sourceType: row.sourceType as MistakeSource,
    sourceLabel: MISTAKE_SOURCE_LABEL_ZH[row.sourceType as MistakeSource] ?? row.sourceType,
    studyRecordId: row.studyRecordId,
    originalQuestion: row.originalQuestion,
    myAnswer: row.myAnswer,
    correctAnswer: row.correctAnswer,
    errorReason: row.errorReason,
    knowledgePoint: row.knowledgePoint,
    errorCategory: row.errorCategory as ErrorCategory,
    errorCategoryLabel:
      ERROR_CATEGORY_LABEL_ZH[row.errorCategory as ErrorCategory] ?? row.errorCategory,
    ieltsErrorCategory: (row.ieltsErrorCategory as IeltsErrorCategory | null) ?? null,
    ieltsErrorCategoryLabel: row.ieltsErrorCategory
      ? (IELTS_ERROR_CATEGORY_LABEL_ZH[row.ieltsErrorCategory as IeltsErrorCategory] ??
        row.ieltsErrorCategory)
      : null,
    reviewCount: row.reviewCount,
    lastReviewAt: row.lastReviewAt,
    nextReviewAt: row.nextReviewAt,
    isMastered: row.isMastered,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** 错题统计（顶部指标 + 「错题类型」图表共用）。 */
export async function getMistakeStats(): Promise<MistakeStatsDto> {
  const [total, mastered, tasks, byCategoryRaw, topPointsRaw] = await Promise.all([
    prisma.mistake.count({ where: { archivedAt: null } }),
    prisma.mistake.count({ where: { archivedAt: null, isMastered: true } }),
    prisma.reviewTask.count({ where: { targetType: 'MISTAKE', status: 'PENDING' } }),
    prisma.mistake.groupBy({
      by: ['errorCategory'],
      where: { archivedAt: null },
      _count: { _all: true },
    }),
    prisma.mistake.groupBy({
      by: ['knowledgePoint'],
      where: { archivedAt: null, isMastered: false },
      _count: { _all: true },
      orderBy: { _count: { knowledgePoint: 'desc' } },
      take: MISTAKE_TOP_KNOWLEDGE_POINTS,
    }),
  ]);

  const countMap = new Map<string, number>();
  for (const row of byCategoryRaw) {
    countMap.set(row.errorCategory, row._count._all);
  }

  return {
    total,
    mastered,
    pendingReviewTask: tasks,
    byCategory: ERROR_CATEGORIES.map((category) => ({
      category,
      label: ERROR_CATEGORY_LABEL_ZH[category],
      count: countMap.get(category) ?? 0,
    })),
    topKnowledgePoints: topPointsRaw.map((row) => ({
      name: row.knowledgePoint,
      count: row._count._all,
    })),
  };
}

/** 已出现过的知识点（筛选下拉用）。 */
export async function listMistakeKnowledgePoints(): Promise<string[]> {
  const rows = await prisma.mistake.findMany({
    where: { archivedAt: null },
    select: { knowledgePoint: true },
    distinct: ['knowledgePoint'],
    orderBy: { knowledgePoint: 'asc' },
    take: 200,
  });
  return rows.map((row) => row.knowledgePoint);
}
