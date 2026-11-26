/**
 * /cycle 只读查询。
 *
 * DTO 里的 `phase` 与 `dayIndex` 由业务日期现算，不落库 —— 日期口径只有一处。
 */

import { countCycleEvidence } from '@/lib/cycleCounts';
import { getBusinessTimezone } from '@/lib/businessTime';
import { toBusinessDate } from '@/lib/date';
import { computeCycleProgress } from '@/lib/domain/cycle';
import { previewOutput } from '@/lib/domain/evidence';
import { parseStringArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type {
  CycleBoardDto,
  CycleEvidenceOptionDto,
  CyclePhaseCode,
  CycleStatus,
  EvidenceLevel,
  EvidenceSkill,
  LearningCycleDto,
  LearningEvidenceType,
  WeeklyFocusDto,
  WeeklyFocusStatus,
} from '@/lib/types';

interface CycleRow {
  id: string;
  title: string;
  goal: string;
  deliverable: string | null;
  startDate: string;
  endDate: string;
  status: string;
  baselineRefs: string | null;
  recoveryNote: string | null;
  weeklyFocus: Array<{
    id: string;
    cycleId: string;
    weekIndex: number;
    weekStart: string;
    focusQuestion: string;
    inputText: string | null;
    outputText: string | null;
    feedbackText: string | null;
    transferEvidenceId: string | null;
    nextDecision: string | null;
    status: string;
  }>;
}

function mapFocus(row: CycleRow['weeklyFocus'][number]): WeeklyFocusDto {
  return {
    id: row.id,
    cycleId: row.cycleId,
    weekIndex: row.weekIndex,
    weekStart: row.weekStart,
    focusQuestion: row.focusQuestion,
    inputText: row.inputText,
    outputText: row.outputText,
    feedbackText: row.feedbackText,
    transferEvidenceId: row.transferEvidenceId,
    nextDecision: row.nextDecision,
    status: row.status as WeeklyFocusStatus,
  };
}

function mapCycle(row: CycleRow, todayStr: string): LearningCycleDto {
  const progress = computeCycleProgress(row.startDate, todayStr);
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    deliverable: row.deliverable,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status as CycleStatus,
    phase: progress.phase as CyclePhaseCode | null,
    dayIndex: Math.max(0, progress.dayNumber),
    baselineRefs: parseStringArray(row.baselineRefs),
    recoveryNote: row.recoveryNote,
    weeklyFocus: [...row.weeklyFocus]
      .sort((a, b) => a.weekIndex - b.weekIndex)
      .map(mapFocus),
  };
}

/** 页面一次性取数：进行中周期、历史周期、证据选项、周期内计数。 */
export async function getCycleBoard(todayStr: string): Promise<CycleBoardDto> {
  const timeZone = await getBusinessTimezone();
  const rows = await prisma.learningCycle.findMany({
    where: { archivedAt: null },
    orderBy: [{ startDate: 'desc' }],
    take: 24,
    include: { weeklyFocus: { orderBy: { weekIndex: 'asc' } } },
  });

  const cycles = rows.map((row) => mapCycle(row, todayStr));
  const active = cycles.find((cycle) => cycle.status !== 'COMPLETED') ?? null;
  const history = cycles.filter((cycle) => cycle.status === 'COMPLETED');

  const evidenceRows = await prisma.evidenceRecord.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 80,
    select: {
      id: true,
      skill: true,
      evidenceType: true,
      level: true,
      outputText: true,
      note: true,
      createdAt: true,
    },
  });
  const evidenceOptions: CycleEvidenceOptionDto[] = evidenceRows.map((row) => ({
    id: row.id,
    skill: row.skill as EvidenceSkill,
    evidenceType: row.evidenceType as LearningEvidenceType,
    level: row.level as EvidenceLevel,
    preview: previewOutput(row.outputText ?? row.note, 50),
    businessDate: toBusinessDate(row.createdAt, timeZone),
  }));

  const counts = active
    ? await countCycleEvidence(active.startDate, active.endDate, timeZone)
    : { comparableOutputs: 0, deliveryEvidence: 0 };

  return {
    active,
    history,
    evidenceOptions,
    comparableOutputs: counts.comparableOutputs,
    deliveryEvidence: counts.deliveryEvidence,
  };
}
