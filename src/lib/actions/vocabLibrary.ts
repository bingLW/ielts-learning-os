'use server';

/**
 * 词库与词条导入的 Server Actions（v2.3 Phase 1）。
 *
 * 导入永远是两段式：`preview` 只读不写，`commit` 重新解析并写库。
 * 两次都重算 `EXISTS / CONFLICT`，因为预览可能停留很久，库在此期间会变。
 */

import { revalidatePath } from 'next/cache';
import { buildImportPreview, vocabularyKey } from '@/lib/domain/vocabImport';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import {
  createVocabDeckSchema,
  vocabImportCommitSchema,
  vocabImportPreviewSchema,
} from '@/lib/schema/vocabIntegration';
import type { ActionResult, NormalizedVocabItem, VocabImportPreview } from '@/lib/types';
import { persistImportedItems } from '@/lib/vocabImportPersist';

/** 按文件里的 lemma 批量取库中已有释义，生成 `EXISTS / CONFLICT` 判定用的映射。 */
async function loadExistingMap(text: string, fileName: string): Promise<Map<string, string | null>> {
  const probe = buildImportPreview({ fileName, text, previewLimit: Infinity });
  const lemmas = new Set<string>();
  for (const row of probe.rows) {
    if (row.item) lemmas.add(row.item.normalizedLemma);
  }
  const existing = new Map<string, string | null>();
  const list = [...lemmas];
  // SQLite 对 IN 参数个数有限制，分批查询
  for (let index = 0; index < list.length; index += 400) {
    const chunk = list.slice(index, index + 400);
    const items = await prisma.vocabularyItem.findMany({
      where: { language: 'en', normalizedLemma: { in: chunk }, archivedAt: null },
      select: { normalizedLemma: true, pos: true, senseKey: true, definitionZh: true },
    });
    for (const item of items) {
      existing.set(
        vocabularyKey({
          normalizedLemma: item.normalizedLemma,
          pos: item.pos,
          senseKey: item.senseKey,
        }),
        item.definitionZh,
      );
    }
  }
  return existing;
}

/** 解析并预览（不写库），供导入弹窗确认。 */
export async function previewVocabImportAction(
  raw: unknown,
): Promise<ActionResult<VocabImportPreview>> {
  const parsed = vocabImportPreviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  try {
    const existing = await loadExistingMap(parsed.data.text, parsed.data.fileName);
    const preview = buildImportPreview({
      fileName: parsed.data.fileName,
      text: parsed.data.text,
      existing,
    });
    return ok(preview);
  } catch (error) {
    return fail('VALIDATION', (error as Error).message);
  }
}

/** 确认导入：只写预览判为 NEW 的行；勾选冲突覆盖时额外写入 CONFLICT 行。 */
export async function commitVocabImportAction(
  raw: unknown,
): Promise<
  ActionResult<{
    sourceId: string;
    deckId: string;
    created: number;
    updated: number;
    skipped: number;
    linkedToDeck: number;
  }>
> {
  const parsed = vocabImportCommitSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  if (input.deckId) {
    const deck = await prisma.vocabularyDeck.findUnique({
      where: { id: input.deckId },
      select: { id: true, archivedAt: true },
    });
    if (!deck) return fail('NOT_FOUND', '目标词库不存在');
    if (deck.archivedAt) return fail('PRECONDITION', '目标词库已归档，不能继续导入');
  }

  let preview: VocabImportPreview;
  try {
    const existing = await loadExistingMap(input.text, input.fileName);
    preview = buildImportPreview({
      fileName: input.fileName,
      text: input.text,
      existing,
      previewLimit: Infinity,
    });
  } catch (error) {
    return fail('VALIDATION', (error as Error).message);
  }
  if (preview.blockingErrors.length > 0) {
    return fail('VALIDATION', preview.blockingErrors.join('；'));
  }

  const accepted: NormalizedVocabItem[] = [];
  for (const row of preview.rows) {
    if (!row.item) continue;
    if (row.status === 'NEW') accepted.push(row.item);
    else if (row.status === 'CONFLICT' && input.includeConflicts) accepted.push(row.item);
  }
  if (accepted.length === 0) {
    return fail('PRECONDITION', '没有可导入的新词条：全部为已存在、文件内重复或无效行');
  }

  const sourceTitle =
    input.deckTitle?.trim() ||
    input.fileName.replace(/\.[^.]+$/, '').trim() ||
    '未命名导入词库';

  const result = await prisma.$transaction(async (tx) => {
    return persistImportedItems(tx, {
      items: accepted,
      sourceTitle,
      sourceType: 'IMPORT',
      includeConflicts: input.includeConflicts,
      deckId: input.deckId || null,
      deckTitle: input.deckTitle ?? sourceTitle,
      targetStage: input.targetStage ?? null,
    });
  });

  revalidatePath('/vocabulary');
  revalidatePath('/vocabulary/library');
  revalidatePath('/');
  return ok(result);
}

/** 新建空词库（后续可用导入追加词条，或手工添加）。 */
export async function createVocabDeckAction(
  raw: unknown,
): Promise<ActionResult<{ deckId: string }>> {
  const parsed = createVocabDeckSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const duplicate = await prisma.vocabularyDeck.findFirst({
    where: { title: parsed.data.title, archivedAt: null },
    select: { id: true },
  });
  if (duplicate) return fail('CONFLICT', '已有同名词库，请换一个名称或直接导入到该词库');

  const created = await prisma.vocabularyDeck.create({
    data: {
      title: parsed.data.title,
      targetStage: parsed.data.targetStage ?? null,
      dailyNewTarget: parsed.data.dailyNewTarget,
      reviewCap: parsed.data.reviewCap,
      note: parsed.data.note ?? null,
    },
    select: { id: true },
  });

  revalidatePath('/vocabulary');
  revalidatePath('/vocabulary/library');
  return ok({ deckId: created.id });
}

/** 归档词库：不删词条、不删历史会话，只让计划不再从它取候选。 */
export async function archiveVocabDeckAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const deckId =
    typeof raw === 'object' && raw !== null ? (raw as { deckId?: unknown }).deckId : null;
  if (typeof deckId !== 'string' || deckId.length === 0) {
    return fail('VALIDATION', '缺少词库 ID');
  }

  const deck = await prisma.vocabularyDeck.findUnique({
    where: { id: deckId },
    select: { id: true, archivedAt: true },
  });
  if (!deck) return fail('NOT_FOUND', '词库不存在');
  if (deck.archivedAt) return ok({ ok: true });

  await prisma.vocabularyDeck.update({
    where: { id: deckId },
    data: { status: 'ARCHIVED', archivedAt: new Date() },
  });

  revalidatePath('/vocabulary');
  revalidatePath('/vocabulary/library');
  revalidatePath('/plan');
  return ok({ ok: true });
}
