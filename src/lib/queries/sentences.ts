/**
 * 句子成分只读查询（T27）。
 */

import type { Prisma } from '@prisma/client';
import {
  PAGE_SIZE,
  PATTERN_TAG_LABEL_ZH,
  SENTENCE_COMPONENT_LABEL_ZH,
  SENTENCE_COMPONENTS,
} from '@/lib/constants';
import { resolveBusinessDate } from '@/lib/businessTime';
import { parseJson } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type {
  PartOfSpeech,
  PatternTag,
  SentenceComponent,
  SentenceRowDto,
  SentenceStatsDto,
  SentenceTokenDto,
} from '@/lib/types';

/** 把库里的 `tokens` JSON 还原成安全对象数组。 */
export function parseTokens(raw: string | null): SentenceTokenDto[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const out: SentenceTokenDto[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text : '';
    if (text.length === 0) continue;
    const component =
      typeof record.component === 'string' && record.component.length > 0
        ? (record.component as SentenceComponent)
        : null;
    const pos =
      typeof record.pos === 'string' && record.pos.length > 0
        ? (record.pos as PartOfSpeech)
        : null;
    out.push({ text, component, pos });
  }
  return out;
}

/** 列表筛选。 */
export interface SentenceFilter {
  patternTag?: PatternTag | 'ALL';
  onlyError?: boolean;
  from?: string;
  to?: string;
  q?: string;
}

/** 句子分析列表。 */
export async function listSentences(filter: SentenceFilter = {}): Promise<SentenceRowDto[]> {
  const where: Prisma.SentenceAnalysisWhereInput = { archivedAt: null };
  if (filter.patternTag && filter.patternTag !== 'ALL') where.patternTag = filter.patternTag;
  if (filter.onlyError) where.isCorrect = false;
  if (filter.from || filter.to) {
    where.sentenceDate = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }
  if (filter.q && filter.q.trim().length > 0) {
    where.sentenceEn = { contains: filter.q.trim() };
  }

  const rows = await prisma.sentenceAnalysis.findMany({
    where,
    orderBy: [{ sentenceDate: 'desc' }, { createdAt: 'desc' }],
    take: PAGE_SIZE * 4,
  });

  return rows.map((row) => {
    const patternTag = (row.patternTag as PatternTag | null) ?? null;
    return {
      id: row.id,
      stageId: row.stageId,
      sentenceEn: row.sentenceEn,
      sentenceZh: row.sentenceZh,
      tokens: parseTokens(row.tokens),
      isCorrect: row.isCorrect,
      errorReason: row.errorReason,
      patternTag,
      patternLabel: patternTag ? (PATTERN_TAG_LABEL_ZH[patternTag] ?? row.patternTag) : null,
      sentenceDate: row.sentenceDate,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/** 句子页统计（成分计数与句型计数）。 */
export async function getSentenceStats(): Promise<SentenceStatsDto> {
  const [rows, patternRows] = await Promise.all([
    prisma.sentenceAnalysis.findMany({
      where: { archivedAt: null },
      select: { tokens: true, isCorrect: true },
    }),
    prisma.sentenceAnalysis.groupBy({
      by: ['patternTag'],
      where: { archivedAt: null, patternTag: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const componentTotals: Record<SentenceComponent, number> = {
    S: 0,
    V: 0,
    O: 0,
    C: 0,
    ADVERBIAL: 0,
  };
  let correct = 0;

  for (const row of rows) {
    if (row.isCorrect) correct += 1;
    for (const token of parseTokens(row.tokens)) {
      if (token.component && token.component in componentTotals) {
        componentTotals[token.component] += 1;
      }
    }
  }

  return {
    total: rows.length,
    correct,
    error: rows.length - correct,
    componentCounts: SENTENCE_COMPONENTS.map((component) => ({
      component,
      label: SENTENCE_COMPONENT_LABEL_ZH[component],
      count: componentTotals[component],
    })),
    patterns: patternRows
      .map((row) => {
        const tag = row.patternTag as PatternTag;
        return {
          tag,
          label: PATTERN_TAG_LABEL_ZH[tag] ?? String(row.patternTag),
          count: row._count._all,
        };
      })
      .sort((a, b) => b.count - a.count),
  };
}

/** 最近 N 条句子（Dashboard / 记录详情侧栏用）。 */
export async function listRecentSentences(limit = 5, nowDateParam?: string) {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const rows = await prisma.sentenceAnalysis.findMany({
    where: { archivedAt: null, sentenceDate: { lte: nowDate } },
    orderBy: [{ sentenceDate: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    sentenceEn: row.sentenceEn,
    sentenceDate: row.sentenceDate,
  }));
}
