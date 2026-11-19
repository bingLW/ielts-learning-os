'use server';

/**
 * 句子成分 Server Actions（T27）。
 *
 * 落库前做两件事：
 * 1. 用 `domain/sentence.ts` 校验 token（成分与词性分别校验，绝不交叉）；
 * 2. 把空串成分/词性统一转成 `null`，保证库里的 JSON 语义干净。
 */

import { revalidatePath } from 'next/cache';
import { validateTokens } from '@/lib/domain/sentence';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { archiveSentenceSchema, createSentenceSchema } from '@/lib/schema/sentence';
import type {
  ActionResult,
  PartOfSpeech,
  SentenceComponent,
  SentenceTokenDto,
} from '@/lib/types';

/** 统一刷新路径。 */
function revalidateSentencePaths(): void {
  revalidatePath('/sentences');
  revalidatePath('/');
}

/** 新增一条句子分析。 */
export async function createSentenceAction(
  raw: unknown,
): Promise<ActionResult<{ sentenceId: string }>> {
  const parsed = createSentenceSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const stage = await prisma.stage.findUnique({ where: { id: input.stageId } });
  if (!stage) return fail('NOT_FOUND', '阶段不存在');

  // 空串 → null；成分与词性各自独立处理
  const tokens: SentenceTokenDto[] = input.tokens.map((token) => ({
    text: token.text,
    component:
      token.component && token.component.length > 0
        ? (token.component as SentenceComponent)
        : null,
    pos: token.pos && token.pos.length > 0 ? (token.pos as PartOfSpeech) : null,
  }));

  const validation = validateTokens(tokens);
  if (!validation.ok) return fail('VALIDATION', validation.message, { tokens: validation.message });

  if (!input.isCorrect && !nullIfEmpty(input.errorReason)) {
    return fail('VALIDATION', '标为「标错」时必须填写错误原因', {
      errorReason: '请填写错误原因',
    });
  }

  const created = await prisma.sentenceAnalysis.create({
    data: {
      stageId: input.stageId,
      sentenceEn: input.sentenceEn.trim(),
      sentenceZh: nullIfEmpty(input.sentenceZh),
      tokens: stringify(tokens) ?? '[]',
      isCorrect: input.isCorrect,
      errorReason: nullIfEmpty(input.errorReason),
      patternTag: nullIfEmpty(input.patternTag),
      sourceRecordId: nullIfEmpty(input.sourceRecordId),
      sentenceDate: input.sentenceDate,
    },
  });

  revalidateSentencePaths();
  return ok({ sentenceId: created.id });
}

/** 归档句子分析（软删除）。 */
export async function archiveSentenceAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = archiveSentenceSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.sentenceAnalysis.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return fail('NOT_FOUND', '句子不存在或已被删除');
  if (existing.archivedAt) return ok({ ok: true });

  await prisma.sentenceAnalysis.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
  });

  revalidateSentencePaths();
  return ok({ ok: true });
}
