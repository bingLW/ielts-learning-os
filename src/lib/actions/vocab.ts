'use server';

/**
 * 词汇与抽测 Server Actions（T26）。
 *
 * 抽测会话（`VocabQuiz` + `VocabQuizItem`）与复习点（`ReviewTask`）都是 append-only：
 * 只新增，永不覆盖历史。三档掌握度各自独立写回，不存在「已掌握」布尔字段。
 */

import { revalidatePath } from 'next/cache';
import {
  EST_MINUTES_BY_INTERVAL,
  MASTERY_LABEL_ZH,
  MASTERY_WEIGHT,
  QUIZ_PASS,
  REVIEW_INTERVAL_DAYS,
  VOCAB_NEW_DEFAULT,
} from '@/lib/constants';
import { businessToday } from '@/lib/businessTime';
import { addDays, diffDays } from '@/lib/date';
import { quizAccuracy, suggestNewWordCount } from '@/lib/domain/vocab';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import {
  archiveVocabWordSchema,
  createVocabWordSchema,
  submitVocabQuizSchema,
  updateVocabWordSchema,
} from '@/lib/schema/vocab';
import type { ActionResult, MasteryLevel } from '@/lib/types';

/** 统一刷新路径。 */
function revalidateVocabPaths(): void {
  revalidatePath('/vocabulary');
  revalidatePath('/review');
  revalidatePath('/');
  revalidatePath('/weekly');
}

/**
 * 新增单词（单词唯一，重复直接 CONFLICT，不静默覆盖）。
 *
 * 与架构 §5 的契约一致：**新增即排第一个 D1 复习点**（`dueDate = max(learnedDate+1, today)`），
 * 否则「今天背的单词」永远不会出现在复习队列里 —— 这是词汇能留存的关键一步。
 */
export async function createVocabWordAction(
  raw: unknown,
): Promise<ActionResult<{ wordId: string; firstReviewDate: string }>> {
  const parsed = createVocabWordSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const duplicate = await prisma.vocabWord.findUnique({
    where: { word: input.word.trim() },
    select: { id: true },
  });
  if (duplicate) {
    return fail('CONFLICT', `单词「${input.word.trim()}」已存在`, {
      word: '该单词已在词汇表中',
    });
  }

  const todayStr = await businessToday();
  const natural = addDays(input.learnedDate, REVIEW_INTERVAL_DAYS.D1);
  // 新点不落在过去（架构 §10-5）；已存在的历史点才允许保留逾期
  const firstReviewDate = diffDays(todayStr, natural) < 0 ? todayStr : natural;

  const created = await prisma.$transaction(async (tx) => {
    const word = await tx.vocabWord.create({
      data: {
        word: input.word.trim(),
        phonetic: nullIfEmpty(input.phonetic),
        partOfSpeech: nullIfEmpty(input.partOfSpeech),
        meaningZh: input.meaningZh.trim(),
        meaningEn: nullIfEmpty(input.meaningEn),
        collocation: nullIfEmpty(input.collocation),
        exampleSentence: nullIfEmpty(input.exampleSentence),
        source: input.source,
        learnedDate: input.learnedDate,
        mastery: input.mastery,
        nextReviewAt: nullIfEmpty(input.nextReviewAt) ?? firstReviewDate,
        isNew: true,
      },
    });

    await tx.reviewTask.create({
      data: {
        targetType: 'VOCAB_WORD',
        targetId: word.id,
        targetLabel: word.word,
        intervalCode: 'D1',
        dueDate: firstReviewDate,
        estMinutes: EST_MINUTES_BY_INTERVAL.D1,
      },
    });

    return word;
  });

  revalidateVocabPaths();
  return ok({ wordId: created.id, firstReviewDate });
}

/** 编辑单词。 */
export async function updateVocabWordAction(
  raw: unknown,
): Promise<ActionResult<{ wordId: string }>> {
  const parsed = updateVocabWordSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const existing = await prisma.vocabWord.findUnique({ where: { id: input.id } });
  if (!existing) return fail('NOT_FOUND', '单词不存在或已被删除');

  const sameWord = await prisma.vocabWord.findUnique({
    where: { word: input.word.trim() },
    select: { id: true },
  });
  if (sameWord && sameWord.id !== existing.id) {
    return fail('CONFLICT', '另一个单词条目已使用该拼写', { word: '拼写与已有单词重复' });
  }

  await prisma.vocabWord.update({
    where: { id: existing.id },
    data: {
      word: input.word.trim(),
      phonetic: nullIfEmpty(input.phonetic),
      partOfSpeech: nullIfEmpty(input.partOfSpeech),
      meaningZh: input.meaningZh.trim(),
      meaningEn: nullIfEmpty(input.meaningEn),
      collocation: nullIfEmpty(input.collocation),
      exampleSentence: nullIfEmpty(input.exampleSentence),
      source: input.source,
      learnedDate: input.learnedDate,
      mastery: input.mastery,
      nextReviewAt: nullIfEmpty(input.nextReviewAt),
    },
  });

  revalidateVocabPaths();
  return ok({ wordId: existing.id });
}

/** 归档单词（软删除）+ 跳过待复习点。 */
export async function archiveVocabWordAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = archiveVocabWordSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.vocabWord.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return fail('NOT_FOUND', '单词不存在或已被删除');
  if (existing.archivedAt) return ok({ ok: true });

  await prisma.$transaction(async (tx) => {
    await tx.vocabWord.update({ where: { id: existing.id }, data: { archivedAt: new Date() } });
    await tx.reviewTask.updateMany({
      where: { targetType: 'VOCAB_WORD', targetId: existing.id, status: 'PENDING' },
      data: { status: 'SKIPPED', skippedReason: '单词已归档' },
    });
  });

  revalidateVocabPaths();
  return ok({ ok: true });
}

/**
 * 提交一次随机抽测。
 *
 * 加权正确率 = `Σ权重 / 词数`（能主动用 1.0 / 能理解 0.7 / 认识但不能用 0.3）。
 * 三档计数分别累加，绝不合并成单一「已掌握」。
 */
export async function submitVocabQuizAction(raw: unknown): Promise<
  ActionResult<{
    quizId: string;
    sampleSize: number;
    weightedAccuracy: number | null;
    recommendation: string;
    passed: boolean;
  }>
> {
  const parsed = submitVocabQuizSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const wordIds = [...new Set(input.answers.map((answer) => answer.wordId))];
  const words = await prisma.vocabWord.findMany({
    where: { id: { in: wordIds }, archivedAt: null },
    select: { id: true, word: true, mastery: true },
  });
  if (words.length === 0) return fail('NOT_FOUND', '所选单词不存在或已归档');

  const wordMap = new Map(words.map((word) => [word.id, word]));
  const ratings: MasteryLevel[] = [];
  const items: { wordId: string; word: string; selfRating: MasteryLevel; weight: number }[] = [];

  for (const answer of input.answers) {
    const word = wordMap.get(answer.wordId);
    if (!word) continue;
    ratings.push(answer.selfRating);
    items.push({
      wordId: word.id,
      word: word.word,
      selfRating: answer.selfRating,
      weight: MASTERY_WEIGHT[answer.selfRating],
    });
  }
  if (items.length === 0) return fail('NOT_FOUND', '所选单词不存在或已归档');

  const accuracy = quizAccuracy(ratings);
  const passed = accuracy !== null && accuracy >= QUIZ_PASS;
  const suggestion = suggestNewWordCount(accuracy, VOCAB_NEW_DEFAULT);
  const recommendation = `${suggestion.reason}；本次抽测${passed ? '达标' : '未达标'}（门槛 ${Math.round(
    QUIZ_PASS * 100,
  )}%），三档自评：${items
    .slice(0, 3)
    .map((item) => `${item.word}=${MASTERY_LABEL_ZH[item.selfRating]}`)
    .join('，')}${items.length > 3 ? ' 等' : ''}`;

  const nextReviewAt = addDays(input.quizDate, REVIEW_INTERVAL_DAYS.D7);

  const quiz = await prisma.$transaction(async (tx) => {
    const created = await tx.vocabQuiz.create({
      data: {
        quizDate: input.quizDate,
        sampleSize: items.length,
        weightedAccuracy: accuracy,
        recommendation,
        items: {
          create: items.map((item) => ({
            wordId: item.wordId,
            word: item.word,
            selfRating: item.selfRating,
            weight: item.weight,
          })),
        },
      },
    });

    if (input.applyMastery !== false) {
      for (const item of items) {
        // eslint-disable-next-line no-await-in-loop -- 每个单词一行更新，量级 ≤100
        await tx.vocabWord.update({
          where: { id: item.wordId },
          data: {
            mastery: item.selfRating,
            lastReviewAt: input.quizDate,
            nextReviewAt,
            isNew: false,
          },
        });
      }
    }

    // 统一复习调度：抽测过的单词进 D7 复习点（已存在 PENDING 则不重复创建）
    const existingTasks = await tx.reviewTask.findMany({
      where: { targetType: 'VOCAB_WORD', targetId: { in: items.map((item) => item.wordId) } },
      select: { targetId: true, intervalCode: true, dueDate: true },
    });
    const existingKeys = new Set(
      existingTasks.map((task) => `${task.targetId}|${task.intervalCode}|${task.dueDate}`),
    );

    for (const item of items) {
      const key = `${item.wordId}|D7|${nextReviewAt}`;
      if (existingKeys.has(key)) continue;
      // eslint-disable-next-line no-await-in-loop -- 逐条创建复习点，量级 ≤100
      await tx.reviewTask.create({
        data: {
          targetType: 'VOCAB_WORD',
          targetId: item.wordId,
          targetLabel: item.word,
          intervalCode: 'D7',
          dueDate: nextReviewAt,
          estMinutes: EST_MINUTES_BY_INTERVAL.D7,
        },
      });
    }

    return created;
  });

  revalidateVocabPaths();
  return ok({
    quizId: quiz.id,
    sampleSize: items.length,
    weightedAccuracy: accuracy,
    recommendation,
    passed,
  });
}

/** 今日抽测计数（页面提示「今天已抽测 N 次」）。 */
export async function countQuizTodayAction(): Promise<ActionResult<{ count: number }>> {
  const count = await prisma.vocabQuiz.count({ where: { quizDate: await businessToday() } });
  return ok({ count });
}
