/**
 * `/sentences` 句子成分分析（T27）。
 */

import { PATTERN_TAGS } from '@/lib/constants';
import type { PatternTag } from '@/lib/types';
import { getSentenceStats, listSentences } from '@/lib/queries/sentences';
import { getActiveStage, listStagesRaw } from '@/lib/queries/stages';
import { SentencesPageBody } from '@/components/sentences/SentencesPageBody';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function SentencesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const tagRaw = one(params, 'patternTag');
  const patternTag = (PATTERN_TAGS as readonly string[]).includes(tagRaw)
    ? (tagRaw as PatternTag)
    : 'ALL';

  const [rows, stats, stages, activeStage] = await Promise.all([
    listSentences({ patternTag, onlyError: one(params, 'onlyError') === '1', q: one(params, 'q') }),
    getSentenceStats(),
    listStagesRaw(),
    getActiveStage(),
  ]);

  return (
    <SentencesPageBody
      rows={rows}
      stats={stats}
      stages={stages.map((stage) => ({ id: stage.id, nameZh: stage.nameZh }))}
      activeStageId={activeStage?.id ?? null}
      activeStageCode={activeStage?.code ?? null}
      filter={{ patternTag, onlyError: one(params, 'onlyError') === '1', q: one(params, 'q') }}
    />
  );
}
