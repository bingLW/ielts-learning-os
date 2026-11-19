/**
 * `/vocabulary` 词汇（T26）。
 */

import { MASTERY_LEVELS } from '@/lib/constants';
import type { MasteryLevel } from '@/lib/types';
import {
  getVocabStats,
  hasQuizToday,
  listVocabQuizzes,
  listVocabWords,
  masteryWeights,
  pickQuizCandidates,
} from '@/lib/queries/vocab';
import { VocabularyPageBody } from '@/components/vocabulary/VocabularyPageBody';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function VocabularyPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const masteryRaw = one(params, 'mastery');
  const mastery = (MASTERY_LEVELS as readonly string[]).includes(masteryRaw)
    ? (masteryRaw as MasteryLevel)
    : 'ALL';
  const q = one(params, 'q');

  const [rows, stats, quizzes, candidates, quizDone] = await Promise.all([
    listVocabWords({ mastery, q }),
    getVocabStats(),
    listVocabQuizzes(8),
    pickQuizCandidates(50),
    hasQuizToday(),
  ]);

  return (
    <VocabularyPageBody
      rows={rows}
      stats={stats}
      quizzes={quizzes}
      candidates={candidates}
      quizDoneToday={quizDone}
      weights={masteryWeights()}
      filter={{ mastery, q }}
    />
  );
}
