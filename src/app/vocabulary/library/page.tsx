/**
 * `/vocabulary/library` 词库管理与导入。
 */

import { getDeckItems, listVocabDecks } from '@/lib/queries/vocabIntegration';
import { VocabLibraryBody } from '@/components/vocabulary/VocabLibraryBody';

export const dynamic = 'force-dynamic';

export default async function VocabularyLibraryPage() {
  const decks = await listVocabDecks();
  const entries = await Promise.all(
    decks.slice(0, 6).map(async (deck) => [deck.id, await getDeckItems(deck.id, 8)] as const),
  );
  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-base font-semibold text-ink">词库与导入</h1>
        <p className="text-xs text-inkMuted">
          词条身份 = lemma + 词性 + 义项键（senseKey）；同形异义不会被合并。
        </p>
      </header>
      <VocabLibraryBody decks={decks} deckItems={Object.fromEntries(entries)} />
    </div>
  );
}
