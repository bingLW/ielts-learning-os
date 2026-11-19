'use server';

/**
 * EGIU 单元与复测 Server Actions（T21 / T22 / T23 / T24 的写入侧）。
 *
 * 三条硬约束在这里落地：
 * 1. 颜色**只在服务端**由 `domain/color.ts` 判定，客户端不传颜色；
 * 2. 复测记录 append-only：只有 `create`，没有 update / delete；
 * 3. 复习点统一写 `ReviewTask`，只追加、不改期，超过 4 个未完成点自动裁剪。
 */

import { revalidatePath } from 'next/cache';
import { EST_MINUTES_BY_INTERVAL, REVIEW_INTERVAL_DAYS, STAGE_META } from '@/lib/constants';
import { addDays, today } from '@/lib/date';
import { judgeEgiuColor } from '@/lib/domain/color';
import {
  appendAfterRetest,
  generateReviewPoints,
  nextLowFreqDate,
  shouldMarkMastered,
} from '@/lib/domain/review';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import {
  archiveEgiuLessonSchema,
  recordEgiuReviewSchema,
  upsertEgiuLessonSchema,
} from '@/lib/schema/egiu';
import type {
  ActionResult,
  EgiuColor,
  ExistingPoint,
  IntervalCode,
  JudgeBranch,
  PlannedPoint,
  ReviewStageCode,
  ReviewStatus,
  StageCode,
} from '@/lib/types';

/** 判定 + 落库后的返回体。 */
export interface RecordEgiuReviewResult {
  reviewId: string;
  color: EgiuColor;
  reason: string;
  branch: JudgeBranch;
  score: number | null;
  /** 本次新增的复习点（已去重、已按 4 点上限裁剪）。 */
  plannedPoints: PlannedPoint[];
  /** 本次是否触发「掌握」（连续 2 次绿灯且间隔 ≥7 天）。 */
  mastered: boolean;
  greenStreak: number;
}

/** 新建 / 编辑 EGIU 单元。 */
export async function upsertEgiuLessonAction(
  raw: unknown,
): Promise<ActionResult<{ lessonId: string }>> {
  const parsed = upsertEgiuLessonSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const stage = await prisma.stage.findUnique({ where: { id: input.stageId } });
  if (!stage) return fail('NOT_FOUND', '阶段不存在，请先在「阶段与验收」中初始化阶段');
  // 架构 §10-10：EGIU 只在阶段一 / 阶段二启用；S0 / S3 创建即拒绝
  const stageMeta = STAGE_META[stage.code as StageCode];
  if (!stageMeta || !stageMeta.allowedEgiu) {
    return fail(
      'PRECONDITION',
      `「${stageMeta?.nameZh ?? stage.code}」不启用 EGIU 单元，请选择阶段一或阶段二`,
      { stageId: '该阶段不启用 EGIU' },
    );
  }

  const data = {
    stageId: input.stageId,
    resourceId: nullIfEmpty(input.resourceId),
    book: input.book.trim(),
    version: nullIfEmpty(input.version),
    unitNo: input.unitNo.trim(),
    knowledgePoint: input.knowledgePoint.trim(),
    learnedDate: input.learnedDate,
  };

  if (input.id) {
    const existing = await prisma.egiuLesson.findUnique({ where: { id: input.id } });
    if (!existing) return fail('NOT_FOUND', 'EGIU 单元不存在或已被删除');
    await prisma.egiuLesson.update({ where: { id: input.id }, data });
    revalidatePath('/grammar');
    revalidatePath(`/grammar/${input.id}`);
    return ok({ lessonId: input.id });
  }

  const created = await prisma.egiuLesson.create({ data });
  revalidatePath('/grammar');
  revalidatePath('/');
  return ok({ lessonId: created.id });
}

/** 归档（软删除）EGIU 单元；未完成的复习点一并跳过，不会留下孤儿任务。 */
export async function archiveEgiuLessonAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = archiveEgiuLessonSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.egiuLesson.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return fail('NOT_FOUND', 'EGIU 单元不存在或已被删除');
  if (existing.archivedAt) return ok({ ok: true });

  await prisma.$transaction(async (tx) => {
    await tx.egiuLesson.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });
    await tx.reviewTask.updateMany({
      where: { targetType: 'EGIU_LESSON', targetId: existing.id, status: 'PENDING' },
      data: { status: 'SKIPPED', skippedReason: 'EGIU 单元已归档' },
    });
  });

  revalidatePath('/grammar');
  revalidatePath('/review');
  revalidatePath('/');
  return ok({ ok: true });
}

/** 复测档位 → 阶梯间隔（`D0` 不是间隔，返回 null）。 */
function toIntervalCode(stage: ReviewStageCode): IntervalCode | null {
  if (stage === 'D0') return null;
  return stage as IntervalCode;
}

/**
 * 录入一次 EGIU 复测（首测同样走这里，`reviewStage = 'D0'`）。
 *
 * 流程：服务端判定 → append-only 写 `EgiuReview` → 完成到期复习点 →
 * 按规则追加新复习点 → 更新单元当前态与掌握判定。全在一个事务里。
 */
export async function recordEgiuReviewAction(
  raw: unknown,
): Promise<ActionResult<RecordEgiuReviewResult>> {
  const parsed = recordEgiuReviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const lesson = await prisma.egiuLesson.findUnique({
    where: { id: input.lessonId },
    include: { stage: { select: { code: true } } },
  });
  if (!lesson) return fail('NOT_FOUND', 'EGIU 单元不存在');
  if (lesson.archivedAt) return fail('PRECONDITION', '该单元已归档，无法录入复测');

  const stageCode = lesson.stage.code as StageCode;
  const stageMeta = STAGE_META[stageCode];
  if (!stageMeta || !stageMeta.allowedEgiu) {
    return fail(
      'PRECONDITION',
      `当前阶段（${stageMeta?.nameZh ?? stageCode}）不启用 EGIU 三色判定，仅「阶段一 / 阶段二」使用`,
    );
  }

  // ① 三色判定：唯一实现，分支顺序不可调换
  const judgment = judgeEgiuColor({
    total: input.totalQuestions,
    correct: input.correctQuestions,
    explainOK: input.explainOk,
    sentences: input.sentencesCount,
    coreRuleOK: input.coreRuleOk,
  });
  if (!judgment.ok) {
    const message =
      judgment.code === 'CORRECT_GT_TOTAL'
        ? '正确题数不能大于总题数'
        : '题量与正确题数都不能为负数';
    return fail('VALIDATION', message, { correctQuestions: message });
  }

  const color = judgment.judgment.color;
  const reason = judgment.judgment.reason;
  const branch = judgment.judgment.branch;
  const score = judgment.judgment.score ?? null;
  const todayStr = today();

  // ② 幂等：同单元 + 同日期 + 同档位只允许一条（append-only 不等于可重复灌水）
  const duplicate = await prisma.egiuReview.findFirst({
    where: {
      lessonId: lesson.id,
      reviewDate: input.reviewDate,
      reviewStage: input.reviewStage,
    },
    select: { id: true },
  });
  if (duplicate) {
    return fail('CONFLICT', '该单元在此日期已录入过同一档位的复测；复测记录不可重复、不可覆盖');
  }

  // ③ 已有复习点（任意状态都参与去重，避免撞唯一索引）
  const existingRows = await prisma.reviewTask.findMany({
    where: { targetType: 'EGIU_LESSON', targetId: lesson.id },
    select: { intervalCode: true, dueDate: true, status: true },
  });
  const existing: ExistingPoint[] = existingRows.map((row) => ({
    intervalCode: row.intervalCode as IntervalCode,
    dueDate: row.dueDate,
    status: row.status as ReviewStatus,
  }));
  const existingKeys = new Set(
    existingRows.map((row) => `${row.intervalCode}|${row.dueDate}`),
  );

  const interval = toIntervalCode(input.reviewStage);
  const planned =
    interval === null
      ? generateReviewPoints({
          d0: lesson.learnedDate,
          today: todayStr,
          color,
          totalQuestions: input.totalQuestions,
          existing,
        })
      : appendAfterRetest({
          d0: lesson.learnedDate,
          today: todayStr,
          retestInterval: interval,
          result: color,
          existing,
        });
  const plannedPoints = planned.filter(
    (point) => !existingKeys.has(`${point.intervalCode}|${point.dueDate}`),
  );

  // ④ 历史复测（含本次）用于掌握判定
  const history = await prisma.egiuReview.findMany({
    where: { lessonId: lesson.id },
    select: { reviewDate: true, judgedColor: true },
    orderBy: [{ reviewDate: 'asc' }, { createdAt: 'asc' }],
  });
  const mastery = shouldMarkMastered({
    reviews: [
      ...history.map((row) => ({
        reviewDate: row.reviewDate,
        color: row.judgedColor as EgiuColor,
      })),
      { reviewDate: input.reviewDate, color },
    ],
  });

  const breakdownText = input.errorBreakdown
    ? stringify({
        rule_unclear: input.errorBreakdown.rule_unclear ?? 0,
        memory_confusion: input.errorBreakdown.memory_confusion ?? 0,
        careless: input.errorBreakdown.careless ?? 0,
        vocab: input.errorBreakdown.vocab ?? 0,
      })
    : null;

  const targetLabel = `${lesson.book} U${lesson.unitNo} · ${lesson.knowledgePoint}`;
  const dueTask =
    interval === null
      ? null
      : await prisma.reviewTask.findFirst({
          where: {
            targetType: 'EGIU_LESSON',
            targetId: lesson.id,
            intervalCode: interval,
            status: 'PENDING',
          },
          select: { id: true },
        });

  const created = await prisma.$transaction(async (tx) => {
    // 4.1 完成到期的那条复习点（不改 dueDate，只补结果）
    if (dueTask) {
      await tx.reviewTask.update({
        where: { id: dueTask.id },
        data: {
          status: 'DONE',
          result: color === 'GREEN' ? 'PASS' : 'FAIL',
          completedAt: new Date(),
        },
      });
    }

    // 4.2 append-only 写入复测记录
    const review = await tx.egiuReview.create({
      data: {
        lessonId: lesson.id,
        reviewDate: input.reviewDate,
        reviewStage: input.reviewStage,
        totalQuestions: input.totalQuestions,
        correctQuestions: input.correctQuestions,
        explainOk: input.explainOk,
        sentencesCount: input.sentencesCount,
        coreRuleOk: input.coreRuleOk,
        judgedColor: color,
        judgeReason: reason,
        judgeBranch: branch,
        score,
        errorBreakdown: breakdownText,
        reviewTaskId: dueTask?.id ?? null,
      },
    });

    // 4.3 追加新的复习点
    for (const point of plannedPoints) {
      await tx.reviewTask.create({
        data: {
          targetType: 'EGIU_LESSON',
          targetId: lesson.id,
          targetLabel,
          knowledgePoint: lesson.knowledgePoint,
          intervalCode: point.intervalCode,
          dueDate: point.dueDate,
          estMinutes: point.estMinutes,
        },
      });
    }

    // 4.4 掌握 → 转 30 天低频池（追加低频点，不动历史）
    let nextReviewDate: string | null = plannedPoints.length > 0 ? plannedPoints[0].dueDate : null;
    if (mastery.mastered) {
      const lowFreqDate = nextLowFreqDate(input.reviewDate);
      nextReviewDate = lowFreqDate;
      const dedupeKey = `LOW_FREQ_30|${lowFreqDate}`;
      if (!existingKeys.has(dedupeKey)) {
        await tx.reviewTask.create({
          data: {
            targetType: 'EGIU_LESSON',
            targetId: lesson.id,
            targetLabel,
            knowledgePoint: lesson.knowledgePoint,
            intervalCode: 'LOW_FREQ_30',
            dueDate: lowFreqDate,
            estMinutes: EST_MINUTES_BY_INTERVAL.LOW_FREQ_30,
          },
        });
      }
    }

    // 4.5 更新单元当前态（只存当前，不改历史）
    await tx.egiuLesson.update({
      where: { id: lesson.id },
      data: {
        currentColor: color,
        currentScore: score,
        currentReason: reason,
        greenStreak: mastery.greenStreak,
        masteredAt: mastery.mastered ? new Date() : lesson.masteredAt,
        inLowFreqPool: mastery.mastered ? true : lesson.inLowFreqPool,
        nextReviewDate,
        retestCount: interval === null ? lesson.retestCount : lesson.retestCount + 1,
      },
    });

    return review;
  });

  revalidatePath('/grammar');
  revalidatePath(`/grammar/${lesson.id}`);
  revalidatePath('/review');
  revalidatePath('/');
  revalidatePath('/weekly');

  return ok({
    reviewId: created.id,
    color,
    reason,
    branch,
    score,
    plannedPoints,
    mastered: mastery.mastered,
    greenStreak: mastery.greenStreak,
  });
}

/**
 * 手动补测（不计入阶梯，只追加一个 MANUAL 点）。
 *
 * 用途：用户想额外再测一次但不想污染 D1/D3/D7 阶梯。
 */
export async function scheduleEgiuManualReviewAction(
  raw: unknown,
): Promise<ActionResult<{ dueDate: string }>> {
  const payload = raw as { lessonId?: unknown };
  const lessonId = typeof payload?.lessonId === 'string' ? payload.lessonId : '';
  if (lessonId.length === 0) return fail('VALIDATION', '缺少单元 ID');

  const lesson = await prisma.egiuLesson.findUnique({ where: { id: lessonId } });
  if (!lesson) return fail('NOT_FOUND', 'EGIU 单元不存在');
  if (lesson.archivedAt) return fail('PRECONDITION', '该单元已归档');

  const dueDate = addDays(today(), REVIEW_INTERVAL_DAYS.MANUAL);
  const exists = await prisma.reviewTask.findFirst({
    where: {
      targetType: 'EGIU_LESSON',
      targetId: lesson.id,
      intervalCode: 'MANUAL',
      dueDate,
    },
    select: { id: true },
  });
  if (exists) return ok({ dueDate });

  await prisma.reviewTask.create({
    data: {
      targetType: 'EGIU_LESSON',
      targetId: lesson.id,
      targetLabel: `${lesson.book} U${lesson.unitNo} · ${lesson.knowledgePoint}`,
      knowledgePoint: lesson.knowledgePoint,
      intervalCode: 'MANUAL',
      dueDate,
      estMinutes: EST_MINUTES_BY_INTERVAL.MANUAL,
    },
  });

  await prisma.egiuLesson.update({
    where: { id: lesson.id },
    data: { nextReviewDate: lesson.nextReviewDate ?? dueDate },
  });

  revalidatePath('/grammar');
  revalidatePath(`/grammar/${lesson.id}`);
  revalidatePath('/review');
  return ok({ dueDate });
}
