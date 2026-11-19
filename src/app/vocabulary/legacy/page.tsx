/**
 * `/vocabulary/legacy` 旧版词汇表（v2.1 的 VocabWord 三档掌握 + 抽测）。
 *
 * v2.3 起 `/vocabulary` 改为词汇引擎概览；旧数据与旧抽测仍完整保留在这里，
 * 不迁移、不删除。
 */

import Link from 'next/link';
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

export default async function VocabularyLegacyPage({ searchParams }: PageProps) {
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
    <div className="space-y-2">
      <p className="text-xs text-inkMuted">
        这是 v2.1 的旧版词汇表（VocabWord 三档掌握 + 随机抽测）。
        <Link href="/vocabulary" className="ml-1 text-brand underline">
          返回 v2.3 词汇引擎概览
        </Link>
      </p>
      <VocabularyPageBody
        rows={rows}
        stats={stats}
        quizzes={quizzes}
        candidates={candidates}
        quizDoneToday={quizDone}
        weights={masteryWeights()}
        filter={{ mastery, q }}
      />
    </div>
  );
}
