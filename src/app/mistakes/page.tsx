/**
 * `/mistakes` 错题本（T25）。
 */

import {
  ERROR_CATEGORIES,
  IELTS_ERROR_CATEGORIES,
} from '@/lib/constants';
import {
  getMistakeStats,
  listMistakeKnowledgePoints,
  listMistakes,
} from '@/lib/queries/mistakes';
import { getActiveStage, listStagesRaw } from '@/lib/queries/stages';
import type { ErrorCategory, MistakeFilterState } from '@/lib/types';
import { MistakesPageBody } from '@/components/mistakes/MistakesPageBody';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function MistakesPage({ searchParams }: PageProps) {
  const params = await searchParams;

  const categoryRaw = one(params, 'errorCategory');
  const masteryRaw = one(params, 'mastery');

  const filter: MistakeFilterState = {
    q: one(params, 'q'),
    errorCategory: (ERROR_CATEGORIES as readonly string[]).includes(categoryRaw)
      ? (categoryRaw as ErrorCategory)
      : 'ALL',
    knowledgePoint: one(params, 'knowledgePoint'),
    mastery:
      masteryRaw === 'MASTERED' || masteryRaw === 'UNMASTERED' ? masteryRaw : 'ALL',
    from: one(params, 'from'),
    to: one(params, 'to'),
    stageId: one(params, 'stageId'),
  };

  const [rows, stats, points, stages, activeStage] = await Promise.all([
    listMistakes(filter),
    getMistakeStats(),
    listMistakeKnowledgePoints(),
    listStagesRaw(),
    getActiveStage(),
  ]);

  return (
    <MistakesPageBody
      rows={rows}
      stats={stats}
      knowledgePoints={points}
      stages={stages.map((stage) => ({ id: stage.id, nameZh: stage.nameZh }))}
      activeStageId={activeStage?.id ?? null}
      filter={filter}
      errorCategories={ERROR_CATEGORIES}
      ieltsCategories={IELTS_ERROR_CATEGORIES}
    />
  );
}
