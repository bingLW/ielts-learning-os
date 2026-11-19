/**
 * 导入词条的落库实现（服务端共用）。
 *
 * 词条身份 = `language + normalizedLemma + pos + senseKey`；
 * 同形异义不合并，冲突时只有显式确认才更新释义，且不改变原 sourceId。
 */

import type { Prisma } from '@prisma/client';
import { stringifyArray } from '@/lib/json';
import type { NormalizedVocabItem } from '@/lib/types';

type Tx = Prisma.TransactionClient;

export interface PersistItemsInput {
  items: NormalizedVocabItem[];
  sourceTitle: string;
  sourceType: 'IMPORT' | 'TYPEWORDS' | 'LEGACY' | 'MANUAL';
  includeConflicts: boolean;
  deckId?: string | null;
  deckTitle?: string | null;
  targetStage?: string | null;
}

export interface PersistItemsResult {
  sourceId: string;
  deckId: string;
  created: number;
  updated: number;
  skipped: number;
  linkedToDeck: number;
}

export async function persistImportedItems(
  tx: Tx,
  input: PersistItemsInput,
): Promise<PersistItemsResult> {
  let source = await tx.vocabularySource.findFirst({
    where: { title: input.sourceTitle, sourceType: input.sourceType },
    select: { id: true },
  });
  if (!source) {
    const created = await tx.vocabularySource.create({
      data: {
        sourceType: input.sourceType,
        title: input.sourceTitle,
        license: input.sourceType === 'TYPEWORDS' ? 'GPL-3.0' : 'user-provided',
        notes: '由 v2.3 词汇导入创建；原始许可由导入者负责确认',
      },
      select: { id: true },
    });
    source = created;
  }

  let deck: { id: string } | null = null;
  if (input.deckId) {
    deck = await tx.vocabularyDeck.findUnique({ where: { id: input.deckId }, select: { id: true } });
  }
  if (!deck) {
    const title = input.deckTitle ?? input.sourceTitle;
    deck = await tx.vocabularyDeck.findFirst({
      where: { title, archivedAt: null },
      select: { id: true },
    });
    if (!deck) {
      deck = await tx.vocabularyDeck.create({
        data: {
          title,
          targetStage: input.targetStage ?? null,
          sourceId: source.id,
          note: '词汇导入自动创建的词库',
        },
        select: { id: true },
      });
    }
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let linkedToDeck = 0;

  for (const item of input.items) {
    const existing = await tx.vocabularyItem.findUnique({
      where: {
        language_normalizedLemma_pos_senseKey: {
          language: 'en',
          normalizedLemma: item.normalizedLemma,
          pos: item.pos,
          senseKey: item.senseKey,
        },
      },
      select: { id: true, definitionZh: true },
    });

    let itemId: string;
    if (existing) {
      itemId = existing.id;
      if (input.includeConflicts) {
        await tx.vocabularyItem.update({
          where: { id: existing.id },
          data: {
            lemma: item.lemma,
            displayForm: item.lemma,
            definitionZh: item.definitionZh,
            definitionEn: item.definitionEn,
            phoneticUk: item.phoneticUk,
            phoneticUs: item.phoneticUs,
            examplesJson: item.examples.length > 0 ? stringifyArray(item.examples) : null,
            collocationsJson: item.collocations.length > 0 ? stringifyArray(item.collocations) : null,
            tagsJson: item.tags.length > 0 ? stringifyArray(item.tags) : null,
          },
        });
        updated += 1;
      } else {
        skipped += 1;
      }
    } else {
      const row = await tx.vocabularyItem.create({
        data: {
          lemma: item.lemma,
          displayForm: item.lemma,
          normalizedLemma: item.normalizedLemma,
          pos: item.pos,
          language: 'en',
          senseKey: item.senseKey,
          definitionZh: item.definitionZh,
          definitionEn: item.definitionEn,
          phoneticUk: item.phoneticUk,
          phoneticUs: item.phoneticUs,
          examplesJson: item.examples.length > 0 ? stringifyArray(item.examples) : null,
          collocationsJson: item.collocations.length > 0 ? stringifyArray(item.collocations) : null,
          tagsJson: item.tags.length > 0 ? stringifyArray(item.tags) : null,
          sourceId: source.id,
          sourceRef: item.sourceRef,
          license: input.sourceType === 'TYPEWORDS' ? 'GPL-3.0' : 'user-provided',
        },
        select: { id: true },
      });
      itemId = row.id;
      created += 1;
    }

    await tx.vocabularyItemSource.upsert({
      where: {
        itemId_sourceId_sourceRef: {
          itemId,
          sourceId: source.id,
          sourceRef: item.sourceRef ?? '',
        },
      },
      update: { note: null },
      create: {
        itemId,
        sourceId: source.id,
        sourceRef: item.sourceRef ?? '',
        note: '导入自动登记',
      },
    });

    const existingLink = await tx.vocabularyDeckItem.findUnique({
      where: { deckId_itemId: { deckId: deck.id, itemId } },
      select: { id: true },
    });
    if (!existingLink) {
      await tx.vocabularyDeckItem.create({
        data: { deckId: deck.id, itemId, sortOrder: await nextSortOrder(tx, deck.id) },
      });
      linkedToDeck += 1;
    }
  }

  return { sourceId: source.id, deckId: deck.id, created, updated, skipped, linkedToDeck };
}

async function nextSortOrder(tx: Tx, deckId: string): Promise<number> {
  const last = await tx.vocabularyDeckItem.findFirst({
    where: { deckId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? -1) + 1;
}
