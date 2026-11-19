'use server';

/**
 * TypeWords 文件交换与词汇证据的 Server Actions（v2.3 Phase 2–4）。
 *
 * 原则：
 * - 导出只生成文件，不写外部系统；官方导入是整库覆盖，必须由用户自己确认；
 * - 导入的每个外部会话只生成 1 条 StudySession + DaySplit，重叠区间不重复计时；
 * - 幂等键 = provider + providerInstanceId + externalSessionId；
 * - TypeWords 的「已掌握」不写入 OS 的七维状态。
 */

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import {
  MODULE_TO_PRIMARY,
  TYPEWORDS_DEFAULT_INSTANCE,
  TYPEWORDS_PINNED_COMMIT,
  VOCAB_MODE_DIMENSIONS,
  VOCAB_PROVIDER,
  type VocabDimension,
  type VocabPracticeMode,
} from '@/lib/constants';
import { parseStringArray, stringify } from '@/lib/json';
import { splitAcrossMidnight, toBusinessDate, today } from '@/lib/date';
import {
  buildTypeWordsBackup,
  effectiveSeconds,
  parseTypeWordsBackup,
  sessionInterval,
  type Interval,
} from '@/lib/domain/vocabSync';
import {
  advanceDimension,
  emptyDimensionStates,
  mergeStatus,
  statusForEvidence,
  toEvidenceGrade,
  type DimensionState,
} from '@/lib/domain/vocabMastery';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import {
  attemptPackageSchema,
  createVocabEvidenceSchema,
  exportVocabDeckSchema,
  importTypeWordsBackupSchema,
  toggleVocabConnectionSchema,
} from '@/lib/schema/vocabIntegration';
import { ensureRetestChain } from '@/lib/retestSchedule';
import { ensureVocabularyRetest } from '@/lib/vocabRetest';
import type { ActionResult, NormalizedVocabItem } from '@/lib/types';
import { generateVocabularyAssignmentForDate } from '@/lib/vocabAssignment';
import { importTypeWordsBackupInTx } from '@/lib/vocabBackupImport';

const TX_OPTIONS = { timeout: 120_000, maxWait: 10_000 };
type Tx = Prisma.TransactionClient;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function fileConnectionId(): Promise<string | null> {
  const connection = await prisma.integrationConnection.findFirst({
    where: { provider: VOCAB_PROVIDER, mode: 'FILE' },
    select: { id: true },
  });
  return connection?.id ?? null;
}

function toNormalizedWords(
  items: Array<{
    lemma: string;
    normalizedLemma: string;
    pos: string;
    senseKey: string;
    definitionZh: string | null;
    definitionEn: string | null;
    phoneticUk: string | null;
    phoneticUs: string | null;
    examplesJson: string | null;
    collocationsJson: string | null;
    tagsJson: string | null;
    sourceRef: string | null;
  }>,
): NormalizedVocabItem[] {
  return items.map((item) => ({
    lemma: item.lemma,
    normalizedLemma: item.normalizedLemma,
    pos: item.pos,
    senseKey: item.senseKey,
    definitionZh: item.definitionZh,
    definitionEn: item.definitionEn,
    phoneticUk: item.phoneticUk,
    phoneticUs: item.phoneticUs,
    examples: parseStringArray(item.examplesJson),
    collocations: parseStringArray(item.collocationsJson),
    tags: parseStringArray(item.tagsJson),
    sourceRef: item.sourceRef,
  }));
}

/** 导出词库为 TypeWords 兼容备份；同时把当日已发出的词汇任务标记为 SENT。 */
export async function exportVocabDeckAction(
  raw: unknown,
): Promise<
  ActionResult<{
    jobId: string;
    fileName: string;
    text: string;
    wordCount: number;
    assignmentMarkedSent: boolean;
  }>
> {
  const parsed = exportVocabDeckSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const deck = await prisma.vocabularyDeck.findUnique({
    where: { id: parsed.data.deckId },
    include: {
      items: {
        orderBy: { sortOrder: 'asc' },
        include: { item: true },
      },
    },
  });
  if (!deck) return fail('NOT_FOUND', '词库不存在');
  if (deck.archivedAt) return fail('PRECONDITION', '词库已归档，不能导出');
  if (deck.items.length === 0) return fail('PRECONDITION', '词库为空，先导入词条再导出');

  const words = toNormalizedWords(deck.items.map((entry) => entry.item));
  const backup = buildTypeWordsBackup({ deckId: deck.id, title: deck.title, words });
  const text = JSON.stringify(backup, null, 2);
  const now = new Date();
  const date = today();
  const fileName = `${deck.title.replace(/[\\/:*?"<>|]/g, '-')}-typewords-${date}.json`;
  const connectionId = await fileConnectionId();

  const assignment = await prisma.vocabularyAssignment.findUnique({
    where: { assignmentDate: date },
    select: { id: true, status: true },
  });
  const markSent = !!assignment && assignment.status === 'PLANNED';

  const job = await prisma.$transaction(async (tx) => {
    if (markSent) {
      await tx.vocabularyAssignment.update({
        where: { id: assignment.id },
        data: { status: 'SENT', sentAt: now },
      });
    }
    await tx.integrationConnection.updateMany({
      where: { id: connectionId ?? '' },
      data: { lastSyncAt: now },
    });
    return tx.integrationJob.create({
      data: {
        connectionId,
        provider: VOCAB_PROVIDER,
        direction: 'EXPORT_DECK',
        status: 'succeeded',
        fileName,
        payloadHash: sha256(text),
        payloadText: text,
        countsJson: stringify({ words: words.length, deckId: deck.id, deckTitle: deck.title }),
        startedAt: now,
        finishedAt: now,
      },
      select: { id: true },
    });
  });

  revalidatePath('/vocabulary');
  revalidatePath('/vocabulary/connection');
  revalidatePath('/vocabulary/sync');
  revalidatePath('/plan');
  return ok({ jobId: job.id, fileName, text, wordCount: words.length, assignmentMarkedSent: markSent });
}

/**
 * 导入 TypeWords 用户数据备份（L1 文件交换）。
 *
 * 备份只有汇总统计，没有逐词 attempts → 全部记为 `SUMMARY_ONLY`。
 * `effectiveSeconds` 会扣除与既有 StudySession / 本次已导入区间重叠的部分。
 */
export async function importTypeWordsBackupAction(
  raw: unknown,
): Promise<
  ActionResult<{
    jobId: string;
    wordsCreated: number;
    wordsUpdated: number;
    wordsSkipped: number;
    sessionsImported: number;
    sessionsSkipped: number;
    minutesCounted: number;
    warnings: string[];
  }>
> {
  const parsed = importTypeWordsBackupSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const payloadHash = sha256(input.text);
  const connectionId = await fileConnectionId();
  const job = await prisma.integrationJob.create({
    data: {
      connectionId,
      provider: VOCAB_PROVIDER,
      direction: 'IMPORT_BACKUP',
      status: 'running',
      fileName: input.fileName,
      payloadHash,
      payloadText: input.text,
      startedAt: new Date(),
    },
    select: { id: true },
  });

  try {
    const backup = parseTypeWordsBackup(input.text);
    const result = await prisma.$transaction(
      (tx) =>
        importTypeWordsBackupInTx(tx, {
          backup,
          jobId: job.id,
          connectionId,
          countTime: input.countTime,
          payloadHash,
        }),
      TX_OPTIONS,
    );

    revalidatePath('/vocabulary');
    revalidatePath('/vocabulary/sync');
    revalidatePath('/vocabulary/connection');
    revalidatePath('/plan');
    revalidatePath('/');
    return ok({
      jobId: job.id,
      wordsCreated: result.persisted.created,
      wordsUpdated: result.persisted.updated,
      wordsSkipped: result.persisted.skipped,
      sessionsImported: result.sessionsImported,
      sessionsSkipped: result.sessionsSkipped,
      minutesCounted: result.minutesCounted,
      warnings: result.warnings,
    });
  } catch (error) {
    await prisma.integrationJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorReport: (error as Error).message,
        finishedAt: new Date(),
      },
    });
    return fail('VALIDATION', (error as Error).message);
  }
}

/** 导入逐词尝试包：写入 ATTEMPT 粒度会话，并按模式推进对应维度。 */
export async function importAttemptPackageAction(
  raw: unknown,
): Promise<
  ActionResult<{
    jobId: string;
    sessionsImported: number;
    sessionsSkipped: number;
    attemptsImported: number;
    minutesCounted: number;
  }>
> {
  const parsed = attemptPackageSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const text = JSON.stringify(parsed.data);
  const job = await prisma.integrationJob.create({
    data: {
      connectionId: await fileConnectionId(),
      provider: VOCAB_PROVIDER,
      direction: 'IMPORT_SESSION',
      status: 'running',
      payloadHash: sha256(text),
      payloadText: text,
      startedAt: new Date(),
    },
    select: { id: true },
  });

  try {
    const result = await prisma.$transaction(async (tx) => {
      let sessionsImported = 0;
      let sessionsSkipped = 0;
      let attemptsImported = 0;
      let minutesCounted = 0;

      for (const session of parsed.data.sessions) {
        const existing = await tx.vocabularyPracticeSession.findUnique({
          where: {
            provider_providerInstanceId_externalSessionId: {
              provider: VOCAB_PROVIDER,
              providerInstanceId: TYPEWORDS_DEFAULT_INSTANCE,
              externalSessionId: session.externalSessionId,
            },
          },
          select: { id: true },
        });
        if (existing) {
          sessionsSkipped += 1;
          continue;
        }

        const startedAt = new Date(session.startedAt);
        const endedAt = new Date(session.endedAt);
        const durationSeconds = Math.max(
          1,
          Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
        );
        const interval: Interval = { startMs: startedAt.getTime(), endMs: endedAt.getTime() };
        const known = await tx.studySession.findMany({
          where: { startedAt: { lt: endedAt }, endedAt: { gt: startedAt } },
          select: { startedAt: true, endedAt: true },
        });
        const counted = effectiveSeconds(
          interval,
          known.map((row) => ({ startMs: row.startedAt.getTime(), endMs: row.endedAt.getTime() })),
        );

        const correct = session.attempts.filter((attempt) => attempt.result === 'CORRECT').length;
        const incorrect = session.attempts.filter((attempt) => attempt.result === 'INCORRECT').length;

        const created = await tx.vocabularyPracticeSession.create({
          data: {
            provider: VOCAB_PROVIDER,
            providerInstanceId: TYPEWORDS_DEFAULT_INSTANCE,
            externalSessionId: session.externalSessionId,
            deckExternalId: session.deckExternalId ?? null,
            mode: session.mode ?? null,
            startedAt,
            endedAt,
            durationSeconds,
            effectiveSeconds: counted,
            overlapAdjusted: counted < durationSeconds,
            correctCount: correct,
            incorrectCount: incorrect,
            granularity: 'ATTEMPT',
            sourceVersion: TYPEWORDS_PINNED_COMMIT,
            payloadHash: sha256(text),
            jobId: job.id,
          },
          select: { id: true },
        });

        const activeMinutes = counted > 0 ? Math.max(1, Math.round(counted / 60)) : 0;
        if (activeMinutes > 0) {
          const splits = splitAcrossMidnight(session.startedAt, activeMinutes);
          const dominant = splits.reduce(
            (best, part) => (part.minutes > best.minutes ? part : best),
            { date: toBusinessDate(startedAt), minutes: 0 },
          );
          const study = await tx.studySession.create({
            data: {
              startedAt,
              endedAt,
              activeMinutes,
              idleMinutes: 0,
              countRatio: 0,
              anomalyFlag: false,
              terminatedReason: 'COMPLETED',
              sessionDate: dominant.date,
              track: 'GENERAL_ENGLISH',
              skill: MODULE_TO_PRIMARY.VOCAB_REVIEW,
            },
            select: { id: true },
          });
          await tx.studySessionDaySplit.createMany({
            data: splits.map((part) => ({
              sessionId: study.id,
              date: part.date,
              minutes: part.minutes,
            })),
          });
          await tx.vocabularyPracticeSession.update({
            where: { id: created.id },
            data: { studySessionId: study.id },
          });
          minutesCounted += activeMinutes;
        }

        for (const attempt of session.attempts) {
          const itemId = await resolveAttemptItem(tx, attempt.externalWordId, attempt.lemma);
          await tx.vocabularyAttempt.create({
            data: {
              sessionId: created.id,
              externalAttemptId: attempt.externalAttemptId,
              externalWordId: attempt.externalWordId ?? null,
              itemId,
              occurredAt: attempt.occurredAt ? new Date(attempt.occurredAt) : null,
              mode: attempt.mode ?? session.mode ?? null,
              result: attempt.result,
              latencyMs: attempt.latencyMs ?? null,
              typedInput: attempt.typedInput ?? null,
            },
          });
          attemptsImported += 1;

          const mode = (attempt.mode ?? session.mode) as VocabPracticeMode | undefined;
          if (itemId && mode && VOCAB_MODE_DIMENSIONS[mode]) {
            const businessDate = toBusinessDate(startedAt);
            for (const dimension of VOCAB_MODE_DIMENSIONS[mode]) {
              await advanceKnowledgeState(tx, {
                itemId,
                dimension,
                mode,
                result: attempt.result,
                businessDate,
              });
            }
          }
        }
        sessionsImported += 1;
      }

      await tx.integrationConnection.updateMany({
        where: { provider: VOCAB_PROVIDER, mode: 'FILE' },
        data: { lastSyncAt: new Date() },
      });

      const counts = { sessionsImported, sessionsSkipped, attemptsImported, minutesCounted };
      await tx.integrationJob.update({
        where: { id: job.id },
        data: { status: 'succeeded', countsJson: stringify(counts), finishedAt: new Date() },
      });
      return counts;
    }, TX_OPTIONS);

    revalidatePath('/vocabulary');
    revalidatePath('/vocabulary/sync');
    revalidatePath('/vocabulary/analytics');
    revalidatePath('/plan');
    return ok({ jobId: job.id, ...result });
  } catch (error) {
    await prisma.integrationJob.update({
      where: { id: job.id },
      data: { status: 'failed', errorReport: (error as Error).message, finishedAt: new Date() },
    });
    return fail('VALIDATION', (error as Error).message);
  }
}

type TxClient = Tx;

/** 外部词条 ID → 本地词条；映射优先，其次按 lemma 的唯一首个匹配。 */
async function resolveAttemptItem(
  tx: TxClient,
  externalWordId: string | null | undefined,
  lemma: string | null | undefined,
): Promise<string | null> {
  if (externalWordId) {
    const mapping = await tx.externalWordMapping.findUnique({
      where: {
        provider_providerInstanceId_externalWordId: {
          provider: VOCAB_PROVIDER,
          providerInstanceId: TYPEWORDS_DEFAULT_INSTANCE,
          externalWordId,
        },
      },
      select: { itemId: true },
    });
    if (mapping?.itemId) return mapping.itemId;
  }
  if (!lemma) return null;
  const item = await tx.vocabularyItem.findFirst({
    where: { normalizedLemma: lemma.trim().toLowerCase(), archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!item) return null;
  if (externalWordId) {
    await tx.externalWordMapping.upsert({
      where: {
        provider_providerInstanceId_externalWordId: {
          provider: VOCAB_PROVIDER,
          providerInstanceId: TYPEWORDS_DEFAULT_INSTANCE,
          externalWordId,
        },
      },
      update: { itemId: item.id, lastSyncedAt: new Date() },
      create: {
        provider: VOCAB_PROVIDER,
        providerInstanceId: TYPEWORDS_DEFAULT_INSTANCE,
        externalWordId,
        itemId: item.id,
        lastSyncedAt: new Date(),
      },
    });
  }
  return item.id;
}

/** 用纯函数推进单个维度，再落库（状态只升不降）。 */
async function advanceKnowledgeState(
  tx: Tx,
  input: {
    itemId: string;
    dimension: VocabDimension;
    mode: VocabPracticeMode;
    result: 'CORRECT' | 'INCORRECT' | 'SKIPPED';
    businessDate: string;
  },
): Promise<void> {
  const row = await tx.vocabularyKnowledgeState.findUnique({
    where: { itemId_dimension: { itemId: input.itemId, dimension: input.dimension } },
  });
  const base: DimensionState =
    row !== null
      ? {
          dimension: input.dimension,
          status: row.status as DimensionState['status'],
          confidence: row.confidence as DimensionState['confidence'],
          evidenceCount: row.evidenceCount,
          lastVerifiedAt: row.lastVerifiedAt,
        }
      : emptyDimensionStates().find((state) => state.dimension === input.dimension)!;

  const next = advanceDimension(base, {
    mode: input.mode,
    result: input.result,
    businessDate: input.businessDate,
    priorVerifiedDate: base.lastVerifiedAt,
  });

  await tx.vocabularyKnowledgeState.upsert({
    where: { itemId_dimension: { itemId: input.itemId, dimension: input.dimension } },
    update: {
      status: next.status,
      confidence: next.confidence,
      evidenceCount: next.evidenceCount,
      lastVerifiedAt: next.lastVerifiedAt,
    },
    create: {
      itemId: input.itemId,
      dimension: input.dimension,
      status: next.status,
      confidence: next.confidence,
      evidenceCount: next.evidenceCount,
      lastVerifiedAt: next.lastVerifiedAt,
    },
  });
}

/**
 * 给某个词条的可观察表现记一条证据，并推进对应维度。
 *
 * 证据类型由分数与级别显式决定（不靠 AI 推断）：
 * - score ≥ 2 且 level ≠ QUICK → APPLIED_TASK（A0 → E4）
 * - 其余 → ASSISTED（→ E1/E2）
 * 维度封顶仍由 `statusForEvidence` 控制：产出使用必须 E4+。
 */
export async function createVocabEvidenceAction(
  raw: unknown,
): Promise<ActionResult<{ evidenceId: string; dimension: string; status: string }>> {
  const parsed = createVocabEvidenceSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const item = await prisma.vocabularyItem.findUnique({
    where: { id: input.itemId },
    select: { id: true, lemma: true, definitionZh: true },
  });
  if (!item) return fail('NOT_FOUND', '词条不存在');

  const evidenceType =
    input.score >= 2 && input.level !== 'QUICK' ? 'APPLIED_TASK' : 'ASSISTED';
  const assistanceLevel = 'A0';
  const grade = toEvidenceGrade({ evidenceType, level: input.level, assistanceLevel });
  const target = statusForEvidence(input.dimension, grade);
  if (!target) {
    return fail(
      'PRECONDITION',
      '该维度的证据等级不足：语境理解（CONTEXT_UNDERSTANDING）至少需要 E2，产出使用（PRODUCTIVE_USE）至少需要 E4',
    );
  }

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const evidence = await tx.evidenceRecord.create({
      data: {
        skill: 'VOCABULARY',
        evidenceType,
        level: input.level,
        sessionId: input.sessionId ?? null,
        conditionJson: stringify({
          prompt: `词汇维度：${input.dimension}`,
          materialSource: item.lemma,
          vocabularyDimension: input.dimension,
          evidenceGrade: grade,
        }),
        outputText: input.typedInput ?? input.scoreReason ?? null,
        score: input.score,
        scoreReason: input.scoreReason ?? null,
        assistanceLevel,
        assessorType: 'SELF',
        note: input.note ?? null,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true, createdAt: true, chainRootId: true },
    });

    await tx.vocabularyEvidenceLink.create({
      data: { evidenceId: evidence.id, itemId: item.id, dimension: input.dimension },
    });

    const row = await tx.vocabularyKnowledgeState.findUnique({
      where: { itemId_dimension: { itemId: item.id, dimension: input.dimension } },
    });
    const current = (row?.status ?? 'UNKNOWN') as DimensionState['status'];
    const nextStatus = mergeStatus(current, target);
    const evidenceCount = (row?.evidenceCount ?? 0) + 1;
    const lastVerifiedAt = toBusinessDate(now);
    await tx.vocabularyKnowledgeState.upsert({
      where: { itemId_dimension: { itemId: item.id, dimension: input.dimension } },
      update: {
        status: nextStatus,
        evidenceCount,
        lastVerifiedAt,
        lastEvidenceId: evidence.id,
        confidence: nextStatus === 'UNKNOWN' ? 'LOW' : evidenceCount >= 2 ? 'MEDIUM' : 'LOW',
      },
      create: {
        itemId: item.id,
        dimension: input.dimension,
        status: nextStatus,
        evidenceCount,
        lastVerifiedAt,
        lastEvidenceId: evidence.id,
      },
    });

    await ensureRetestChain(tx, {
      id: evidence.id,
      skill: 'VOCABULARY',
      evidenceType,
      chainRootId: evidence.chainRootId,
      createdAt: evidence.createdAt,
    });

    // 词汇维度复测走独立阶梯：到期的旧排期由这条证据结清，新的 1/7/30 天排期再补上。
    await ensureVocabularyRetest(tx, {
      evidenceId: evidence.id,
      itemId: item.id,
      lemma: item.lemma,
      dimension: input.dimension,
      status: nextStatus,
      createdAt: now,
    });

    return { evidenceId: evidence.id, status: nextStatus };
  }, TX_OPTIONS);

  revalidatePath('/vocabulary');
  revalidatePath('/vocabulary/library');
  revalidatePath(`/vocabulary/words/${item.id}`);
  revalidatePath('/evidence');
  return ok({ evidenceId: result.evidenceId, dimension: input.dimension, status: result.status });
}

/** 开关文件连接；BRIDGE 模式在 L1 阶段不启用。 */
export async function toggleVocabConnectionAction(
  raw: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = toggleVocabConnectionSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const connection = await prisma.integrationConnection.findUnique({
    where: { id: parsed.data.connectionId },
    select: { id: true, mode: true },
  });
  if (!connection) return fail('NOT_FOUND', '连接不存在');
  if (connection.mode === 'BRIDGE' && parsed.data.enabled) {
    return fail('PRECONDITION', 'BRIDGE 模式默认关闭，v2.3 只启用文件交换（FILE）');
  }

  await prisma.integrationConnection.update({
    where: { id: connection.id },
    data: { enabled: parsed.data.enabled },
  });

  revalidatePath('/vocabulary/connection');
  return ok({ ok: true });
}

/** 手动补生成某天的词汇任务（预算取当日计划里的 VOCAB_REVIEW 任务）。 */
export async function generateVocabAssignmentAction(
  raw: unknown,
): Promise<ActionResult<{ assignmentId: string | null; reviewTarget: number; newTarget: number; warnings: string[] }>> {
  const date =
    typeof raw === 'object' && raw !== null ? (raw as { assignmentDate?: unknown }).assignmentDate : null;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return fail('VALIDATION', '缺少合法日期（YYYY-MM-DD）');
  }

  const planTask = await prisma.planTask.findFirst({
    where: { planDate: date, module: 'VOCAB_REVIEW' },
    select: { plannedMinutes: true },
  });
  if (!planTask) {
    return fail('PRECONDITION', '当日计划没有词汇任务（VOCAB_REVIEW），请先生成或调整计划');
  }

  const result = await generateVocabularyAssignmentForDate(date, planTask.plannedMinutes);
  revalidatePath('/vocabulary');
  revalidatePath('/plan');
  return ok(result);
}
