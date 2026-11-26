/**
 * TypeWords 备份导入的核心事务体（服务端共用，不是 Server Action）。
 *
 * 单独抽出是为了让端到端脚本能直接调用同一份实现：
 * - 一个外部统计只生成 1 条 VocabularyPracticeSession（幂等键去重）；
 * - 有效秒数扣除与既有 StudySession 及本次已导入区间的重叠；
 * - 汇总统计是 SUMMARY_ONLY，不写 VocabularyAttempt、不推进七维状态。
 */

import type { Prisma } from '@prisma/client';
import {
  MODULE_TO_PRIMARY,
  TYPEWORDS_DEFAULT_INSTANCE,
  TYPEWORDS_PINNED_COMMIT,
  VOCAB_PROVIDER,
} from '@/lib/constants';
import { splitAcrossMidnight, toBusinessDate } from '@/lib/date';
import {
  effectiveSeconds,
  sessionInterval,
  type Interval,
  type ParsedTypeWordsBackup,
} from '@/lib/domain/vocabSync';
import { stringify } from '@/lib/json';
import { persistImportedItems, type PersistItemsResult } from '@/lib/vocabImportPersist';

type Tx = Prisma.TransactionClient;

export interface BackupImportInput {
  backup: ParsedTypeWordsBackup;
  jobId: string;
  connectionId: string | null;
  countTime: boolean;
  payloadHash: string;
}

export interface BackupImportResult {
  persisted: PersistItemsResult;
  sessionsImported: number;
  sessionsSkipped: number;
  minutesCounted: number;
  warnings: string[];
}

export async function importTypeWordsBackupInTx(
  tx: Tx,
  input: BackupImportInput,
  timeZone: string,
): Promise<BackupImportResult> {
  const { backup } = input;
  const warnings = [...backup.warnings];

  const minStart =
    backup.sessions.length > 0 ? Math.min(...backup.sessions.map((s) => Date.parse(s.startedAt))) : 0;
  const maxEnd =
    backup.sessions.length > 0 ? Math.max(...backup.sessions.map((s) => Date.parse(s.endedAt))) : 0;
  const existing =
    backup.sessions.length > 0
      ? await tx.studySession.findMany({
          where: { startedAt: { lt: new Date(maxEnd) }, endedAt: { gt: new Date(minStart) } },
          select: { startedAt: true, endedAt: true },
        })
      : [];
  const claimed: Interval[] = existing.map((row) => ({
    startMs: row.startedAt.getTime(),
    endMs: row.endedAt.getTime(),
  }));

  const existingKeys = new Set<string>();
  const keys = backup.sessions.map((session) => session.canonicalKey);
  for (let index = 0; index < keys.length; index += 300) {
    const rows = await tx.vocabularyPracticeSession.findMany({
      where: {
        provider: VOCAB_PROVIDER,
        providerInstanceId: TYPEWORDS_DEFAULT_INSTANCE,
        externalSessionId: { in: keys.slice(index, index + 300) },
      },
      select: { externalSessionId: true },
    });
    for (const row of rows) existingKeys.add(row.externalSessionId);
  }

  const assignmentDates = new Set(
    backup.sessions.map((session) => toBusinessDate(new Date(session.startedAt), timeZone)),
  );
  const assignments = await tx.vocabularyAssignment.findMany({
    where: { assignmentDate: { in: [...assignmentDates] } },
    select: {
      id: true,
      assignmentDate: true,
      planTaskId: true,
      estimatedMinutes: true,
    },
  });
  const assignmentByDate = new Map(assignments.map((row) => [row.assignmentDate, row]));

  const persisted = await persistImportedItems(tx, {
    items: backup.words,
    sourceTitle: `TypeWords 备份：${backup.dictNames.join('、') || '未命名词典'}`,
    sourceType: 'TYPEWORDS',
    includeConflicts: false,
    deckTitle: backup.dictNames[0] ?? 'TypeWords 导入词库',
  });

  let sessionsImported = 0;
  let sessionsSkipped = 0;
  let minutesCounted = 0;
  const dayMinutes = new Map<string, number>();

  for (const session of backup.sessions) {
    if (existingKeys.has(session.canonicalKey)) {
      sessionsSkipped += 1;
      continue;
    }

    const interval = sessionInterval(session);
    const counted = input.countTime ? effectiveSeconds(interval, claimed) : 0;
    if (input.countTime) claimed.push(interval);

    const assignment = assignmentByDate.get(toBusinessDate(new Date(session.startedAt), timeZone));

    const created = await tx.vocabularyPracticeSession.create({
      data: {
        provider: VOCAB_PROVIDER,
        providerInstanceId: TYPEWORDS_DEFAULT_INSTANCE,
        externalSessionId: session.canonicalKey,
        mode: null,
        startedAt: new Date(session.startedAt),
        endedAt: new Date(session.endedAt),
        durationSeconds: session.durationSeconds,
        effectiveSeconds: input.countTime ? counted : null,
        overlapAdjusted: input.countTime && counted < session.durationSeconds,
        summaryJson: stringify({
          total: session.total,
          new: session.newWords,
          review: session.reviewWords,
          wrong: session.wrong,
          sourceTitle: session.sourceTitle,
          sourceVersion: TYPEWORDS_PINNED_COMMIT,
        }),
        correctCount: Math.max(0, session.total - session.wrong),
        incorrectCount: session.wrong,
        granularity: 'SUMMARY_ONLY',
        sourceVersion: TYPEWORDS_PINNED_COMMIT,
        payloadHash: input.payloadHash,
        jobId: input.jobId,
        assignmentId: assignment?.id ?? null,
        planTaskId: assignment?.planTaskId ?? null,
      },
      select: { id: true },
    });

    const activeMinutes = counted > 0 ? Math.max(1, Math.round(counted / 60)) : 0;
    if (activeMinutes > 0) {
      const splits = splitAcrossMidnight(session.startedAt, activeMinutes, timeZone);
      const dominant = splits.reduce(
        (best, part) => (part.minutes > best.minutes ? part : best),
        { date: toBusinessDate(new Date(session.startedAt), timeZone), minutes: 0 },
      );
      const study = await tx.studySession.create({
        data: {
          taskId: assignment?.planTaskId ?? null,
          startedAt: new Date(session.startedAt),
          endedAt: new Date(session.endedAt),
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
      if (splits.length > 0) {
        await tx.studySessionDaySplit.createMany({
          data: splits.map((part) => ({
            sessionId: study.id,
            date: part.date,
            minutes: part.minutes,
          })),
        });
      }
      await tx.vocabularyPracticeSession.update({
        where: { id: created.id },
        data: { studySessionId: study.id },
      });
      minutesCounted += activeMinutes;
      for (const part of splits) {
        dayMinutes.set(part.date, (dayMinutes.get(part.date) ?? 0) + part.minutes);
      }
    } else if (input.countTime && counted === 0) {
      warnings.push(
        `一条统计与已有学习记录完全重叠，只保留会话记录、未计入时长（${session.startedAt}）。`,
      );
    }
    sessionsImported += 1;
  }

  for (const [date, minutes] of dayMinutes) {
    const assignment = assignmentByDate.get(date);
    if (!assignment) continue;
    const nextStatus =
      assignment.estimatedMinutes > 0 && minutes >= assignment.estimatedMinutes
        ? 'DONE'
        : 'IN_PROGRESS';
    await tx.vocabularyAssignment.update({
      where: { id: assignment.id },
      data: { status: nextStatus },
    });
  }

  await tx.integrationConnection.updateMany({
    where: { id: input.connectionId ?? '' },
    data: { lastSyncAt: new Date() },
  });

  const counts = {
    words: {
      created: persisted.created,
      updated: persisted.updated,
      skipped: persisted.skipped,
      linkedToDeck: persisted.linkedToDeck,
    },
    sessions: {
      imported: sessionsImported,
      skipped: sessionsSkipped,
      minutesCounted,
      bookCount: backup.dictNames.length,
    },
    warnings,
  };
  await tx.integrationJob.update({
    where: { id: input.jobId },
    data: {
      status: warnings.length > 0 ? 'partial' : 'succeeded',
      countsJson: stringify(counts),
      finishedAt: new Date(),
    },
  });

  return { persisted, sessionsImported, sessionsSkipped, minutesCounted, warnings };
}
