/**
 * `/vocabulary/today` 今日词汇任务。
 */

import { today } from '@/lib/date';
import { prisma } from '@/lib/prisma';
import { getActiveVocabDeck, getVocabAssignment } from '@/lib/queries/vocabIntegration';
import { VocabTodayBody } from '@/components/vocabulary/VocabTodayBody';

export const dynamic = 'force-dynamic';

export default async function VocabularyTodayPage() {
  const date = today();
  const [assignment, activeDeck, planTask] = await Promise.all([
    getVocabAssignment(date),
    getActiveVocabDeck(),
    prisma.planTask.findFirst({
      where: { planDate: date, module: 'VOCAB_REVIEW' },
      orderBy: { sortOrder: 'asc' },
      select: { plannedMinutes: true },
    }),
  ]);

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-base font-semibold text-ink">今日词汇任务</h1>
        <p className="text-xs text-inkMuted">
          {date} · 预算沿用计划里的词汇模块；词汇时长与四技能共享同一份当日净时长。
        </p>
      </header>
      <VocabTodayBody
        date={date}
        assignment={assignment}
        activeDeckId={activeDeck?.id ?? null}
        planMinutes={planTask?.plannedMinutes ?? null}
      />
    </div>
  );
}
