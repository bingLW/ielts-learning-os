'use server';

/**
 * 英语媒介学习（English-mediated Learning）Server Actions。
 *
 * 一次记录在**单事务**内落四样东西，保证「一条时长只计一次」：
 * 1. `EnglishMediatedSession` —— 媒介学习的元数据（主题/理解度/翻译依赖/产出）；
 * 2. `StudySession` —— 携带 `track=ENGLISH_MEDIATED_LEARNING` + `skill=primarySkill` +
 *    `mediatedId` 快照，是这段时长在「轨道/技能/日净时长」口径下的唯一载体；
 * 3. `StudySessionDaySplit` —— 跨零点分钟拆分，净时长唯一来源；
 * 4. `LearningOutput` —— 英文笔记/摘要/问题各落一条（仅非空项）。
 *
 * `EnglishMediatedSession.durationMinutes` **不参与任何求和**，只做表内自洽校验；
 * 真正的时长以落库的 `StudySession` 为准。
 */

import { revalidatePath } from 'next/cache';
import { splitAcrossMidnight, toUtcInstant } from '@/lib/date';
import { prisma } from '@/lib/prisma';
import { failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { createMediatedSessionSchema } from '@/lib/schema/mediated';
import type { ActionResult } from '@/lib/types';

/** 把一段英文产出（非空才落库）转成 `LearningOutput` 的 create 数据。 */
function toOutput(
  mediatedId: string,
  outputType: 'NOTE_EN' | 'SUMMARY_EN' | 'QUESTION_EN',
  content: string | null | undefined,
) {
  const text = nullIfEmpty(content);
  if (!text) return null;
  return { mediatedId, outputType, content: text, reviewStatus: 'DRAFT' as const };
}

/** 新建一次媒介学习记录。 */
export async function createMediatedSessionAction(
  raw: unknown,
): Promise<ActionResult<{ sessionId: string }>> {
  const parsed = createMediatedSessionSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const input = parsed.data;
  const outputs = [
    toOutput('', 'NOTE_EN', input.notesEn),
    toOutput('', 'SUMMARY_EN', input.summaryEn),
    toOutput('', 'QUESTION_EN', input.questionsEn),
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  const sessionId = await prisma.$transaction(async (tx) => {
    // 1. 媒介学习元数据
    const mediated = await tx.englishMediatedSession.create({
      data: {
        sessionDate: input.sessionDate,
        subject: input.subject.trim(),
        topic: input.topic.trim(),
        sourceTitle: nullIfEmpty(input.sourceTitle),
        sourceUrl: nullIfEmpty(input.sourceUrl),
        sourceType: input.sourceType,
        primarySkill: input.primarySkill,
        durationMinutes: input.durationMinutes,
        languageLevel: input.languageLevel ?? null,
        understanding: input.understanding,
        translationDependency: input.translationDependency,
        notesEn: nullIfEmpty(input.notesEn),
        summaryEn: nullIfEmpty(input.summaryEn),
        questionsEn: nullIfEmpty(input.questionsEn),
        intensity: input.intensity,
        note: nullIfEmpty(input.note),
      },
    });

    // 2. StudySession：这段时长的唯一载体。无真实计时，起止用业务日 00:00 起算。
    const startedAt = toUtcInstant(input.sessionDate);
    const endedAt = new Date(startedAt.getTime() + input.durationMinutes * 60_000);
    const session = await tx.studySession.create({
      data: {
        taskId: null,
        startedAt,
        endedAt,
        activeMinutes: input.durationMinutes,
        idleMinutes: 0,
        countRatio: 0,
        anomalyFlag: false,
        terminatedReason: 'COMPLETED',
        sessionDate: input.sessionDate,
        track: 'ENGLISH_MEDIATED_LEARNING',
        skill: input.primarySkill,
        mediatedId: mediated.id,
      },
    });

    // 3. 跨零点 DaySplit（净时长唯一来源）
    const splits = splitAcrossMidnight(startedAt.toISOString(), input.durationMinutes);
    if (splits.length > 0) {
      await tx.studySessionDaySplit.createMany({
        data: splits.map((split) => ({
          sessionId: session.id,
          date: split.date,
          minutes: split.minutes,
        })),
      });
    }

    // 4. 英文产出
    if (outputs.length > 0) {
      await tx.learningOutput.createMany({
        data: outputs.map((item) => ({ ...item, mediatedId: mediated.id })),
      });
    }

    return mediated.id;
  });

  revalidatePath('/mediated');
  revalidatePath('/');
  revalidatePath('/weekly');
  return ok({ sessionId });
}
