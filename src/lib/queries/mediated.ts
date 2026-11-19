/**
 * 英语媒介学习只读查询。
 *
 * 与 `goals.ts` 的三目标卡共享「媒介证据」口径，但这里面向 `/mediated` 页面：
 * 1. `listMediatedSessions` —— 历史记录列表（含真实净分钟与产出数）；
 * 2. `getMediatedOverview` —— 顶部统计 + 独立 gate 判定。
 *
 * 时长口径：`durationMinutes` 只做表内自洽，**真实净分钟**来自关联
 * `StudySession` 的 `DaySplit.minutes` 求和（净时长唯一来源，绝不混算）。
 */

import { MEDIATED_INTENSITY_BY_PROFILE, MEDIATED_SUMMARY_MIN_CHARS } from '@/lib/constants';
import { evaluateMediatedGate, mediatedOutputCount, type TrackGateResult } from '@/lib/domain/tracks';
import { prisma } from '@/lib/prisma';
import type {
  MediatedIntensity,
  MediatedSessionDto,
  MediatedUnderstanding,
  PrimarySkill,
  StageProfileCode,
  TranslationDependency,
} from '@/lib/types';

/** 当前阶段强度档（与 `goals.ts` 同口径）。 */
async function currentIntensity(): Promise<MediatedIntensity> {
  const stage = await prisma.stage.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { sortOrder: 'desc' },
    select: { profileCode: true },
  });
  const code = (stage?.profileCode as StageProfileCode) ?? null;
  return code ? MEDIATED_INTENSITY_BY_PROFILE[code] : 'A2_B1';
}

/** 一段英文产出是否构成「有效产出」（笔记/摘要/问题，任一非空）。 */
function inlineOutputCount(row: {
  notesEn: string | null;
  summaryEn: string | null;
  questionsEn: string | null;
  outputs: { outputType: string }[];
}): number {
  return mediatedOutputCount({
    outputCount: row.outputs.length,
    notesEn: row.notesEn,
    summaryEn: row.summaryEn,
    questionsEn: row.questionsEn,
  });
}

/** 历史记录列表（按日期倒序）。 */
export async function listMediatedSessions(): Promise<MediatedSessionDto[]> {
  const rows = await prisma.englishMediatedSession.findMany({
    orderBy: [{ sessionDate: 'desc' }, { createdAt: 'desc' }],
    include: {
      outputs: { select: { outputType: true } },
      sessions: { include: { daySplits: { select: { minutes: true } } } },
      evidenceRecords: { where: { archivedAt: null }, select: { id: true }, take: 1 },
    },
  });

  return rows.map((row) => {
    // 真实净分钟 = 关联 StudySession 的 DaySplit 求和（一条 session 只落一条）
    const actualNetMinutes = row.sessions.reduce(
      (sum, session) =>
        sum + session.daySplits.reduce((acc, split) => acc + split.minutes, 0),
      0,
    );

    return {
      id: row.id,
      sessionDate: row.sessionDate,
      subject: row.subject,
      topic: row.topic,
      sourceTitle: row.sourceTitle,
      sourceUrl: row.sourceUrl,
      sourceType: row.sourceType,
      primarySkill: row.primarySkill as PrimarySkill,
      durationMinutes: row.durationMinutes,
      languageLevel: row.languageLevel,
      understanding: row.understanding as MediatedUnderstanding,
      translationDependency: row.translationDependency as TranslationDependency,
      notesEn: row.notesEn,
      summaryEn: row.summaryEn,
      questionsEn: row.questionsEn,
      intensity: row.intensity as MediatedIntensity,
      actualNetMinutes,
      outputCount: inlineOutputCount(row),
      evidenceId: row.evidenceRecords[0]?.id ?? null,
    };
  });
}

/** 媒介学习总览：统计 + gate 判定（独立验收，不与其他轨道换算）。 */
export async function getMediatedOverview(): Promise<{
  totalSessions: number;
  totalMinutes: number;
  totalOutputs: number;
  skillCoverage: Partial<Record<PrimarySkill, number>>;
  gate: TrackGateResult;
  intensity: MediatedIntensity;
  summaryAdequateCount: number;
}> {
  const [rows, intensity] = await Promise.all([
    prisma.englishMediatedSession.findMany({
      orderBy: { sessionDate: 'asc' },
      select: {
        sessionDate: true,
        primarySkill: true,
        durationMinutes: true,
        understanding: true,
        translationDependency: true,
        notesEn: true,
        summaryEn: true,
        questionsEn: true,
        outputs: { select: { outputType: true } },
      },
    }),
    currentIntensity(),
  ]);

  const totalMinutes = rows.reduce((sum, r) => sum + r.durationMinutes, 0);
  const totalOutputs = rows.reduce((sum, r) => sum + inlineOutputCount(r), 0);
  const summaryAdequateCount = rows.filter((r) => (r.summaryEn ?? '').trim().length >= MEDIATED_SUMMARY_MIN_CHARS).length;

  const skillCoverage: Partial<Record<PrimarySkill, number>> = {};
  for (const skill of ['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as PrimarySkill[]) {
    const minutes = rows.filter((r) => r.primarySkill === skill).reduce((s, r) => s + r.durationMinutes, 0);
    skillCoverage[skill] = minutes;
  }

  const evidence = rows.map((r) => ({
    sessionDate: r.sessionDate,
    primarySkill: r.primarySkill,
    durationMinutes: r.durationMinutes,
    understanding: r.understanding,
    translationDependency: r.translationDependency,
    outputCount: inlineOutputCount(r),
    summaryChars: (r.summaryEn ?? '').length,
  }));

  const gate = evaluateMediatedGate({ records: evidence, intensity });

  return {
    totalSessions: rows.length,
    totalMinutes,
    totalOutputs,
    skillCoverage,
    gate,
    intensity,
    summaryAdequateCount,
  };
}
