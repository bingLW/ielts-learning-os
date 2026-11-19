/**
 * 能力评估查询（v2.0 P4）。
 *
 * 两条独立证据链的读取与 gate 聚合：
 *   - `SkillAssessment` → General English gate（`evaluateGeneralEnglishGate`）；
 *   - `IeltsAssessment` → IELTS gate（`evaluateIeltsGate`）。
 * 二者**互不换算**（SOP v2 §2），本模块只做「读」与「喂 gate」，不写任何换算表。
 */

import { IELTS_GATE_MAX_RECORDS, IELTS_GATE_MIN_RECORDS } from '@/lib/constants';
import { accumulatePrimaryMinutes, defaultAllocationFor } from '@/lib/domain/allocation';
import { evaluateGeneralEnglishGate, evaluateIeltsGate } from '@/lib/domain/tracks';
import { prisma } from '@/lib/prisma';
import type {
  AllocationSkill,
  AssessmentType,
  AssessorKind,
  CefrLevel,
  IeltsAssessmentDto,
  IeltsTestType,
  PrimarySkill,
  SkillAllocation,
  SkillAssessmentDto,
  StageProfileCode,
} from '@/lib/types';
import type { TrackGateResult } from '@/lib/domain/tracks';
import { getActiveStage } from './stages';

/** 里程碑展示行。 */
export interface MilestoneRowDto {
  id: string;
  milestoneCode: string;
  title: string;
  description: string | null;
  target: string | null;
  status: 'PENDING' | 'ACHIEVED' | 'FAILED';
  completedAt: string | null;
}

/** CEFR 四技能评估历史（按 skill + assessDate 升序）。 */
export async function listSkillAssessments(): Promise<SkillAssessmentDto[]> {
  const rows = await prisma.skillAssessment.findMany({
    orderBy: [{ skill: 'asc' }, { assessDate: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    skill: r.skill as AllocationSkill,
    cefrLevel: r.cefrLevel as CefrLevel,
    assessmentType: r.assessmentType as AssessmentType,
    score: r.score,
    assessDate: r.assessDate,
    assessor: r.assessor as AssessorKind,
    confidence: r.confidence,
    note: r.note,
  }));
}

/** 雅思成绩历史（按 testDate 升序，便于画趋势）。 */
export async function listIeltsAssessments(): Promise<IeltsAssessmentDto[]> {
  const rows = await prisma.ieltsAssessment.findMany({
    orderBy: { testDate: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    testDate: r.testDate,
    testType: r.testType as IeltsTestType,
    overallBand: r.overallBand,
    listeningBand: r.listeningBand,
    readingBand: r.readingBand,
    writingBand: r.writingBand,
    speakingBand: r.speakingBand,
    source: r.source,
    notes: r.notes,
  }));
}

/** 通用英语轨道总览：配比 + CEFR gate + 里程碑。 */
export async function getGeneralEnglishOverview(): Promise<{
  cefrTarget: CefrLevel;
  assessments: SkillAssessmentDto[];
  gate: TrackGateResult;
  milestones: MilestoneRowDto[];
  allocation: {
    minutes: { LISTENING: number; READING: number; SPEAKING: number; WRITING: number; FOUNDATION: number };
    target: SkillAllocation | null;
    profileCode: StageProfileCode | null;
  };
}> {
  const [profile, stage, geGoal, assessments, splitRows] = await Promise.all([
    prisma.userProfile.findUnique({ where: { id: 1 } }),
    getActiveStage(),
    prisma.learningGoal.findUnique({
      where: { goalType: 'GENERAL_ENGLISH' },
      include: { milestones: { orderBy: { sortOrder: 'asc' } } },
    }),
    prisma.skillAssessment.findMany({ orderBy: [{ skill: 'asc' }, { assessDate: 'asc' }] }),
    prisma.studySessionDaySplit.findMany({
      select: { minutes: true, session: { select: { skill: true } } },
    }),
  ]);

  const cefrTarget = (profile?.cefrTarget ?? 'B2') as CefrLevel;

  const geTotalMinutes = splitRows.reduce((sum, r) => sum + Math.max(0, r.minutes), 0);

  const gate = evaluateGeneralEnglishGate({
    assessments: assessments.map((a) => ({
      skill: a.skill,
      cefrLevel: a.cefrLevel,
      assessDate: a.assessDate,
      confidence: a.confidence,
    })),
    targetLevel: cefrTarget,
    totalMinutes: geTotalMinutes,
  });

  // 四技能配比（全部历史，分母只含四技能 —— accumulatePrimaryMinutes 把非四技能落 FOUNDATION）
  const minutes = accumulatePrimaryMinutes(
    splitRows.map((r) => ({ skill: (r.session?.skill ?? 'FOUNDATION') as PrimarySkill, minutes: r.minutes })),
  );

  const profileCode = (stage?.profileCode as StageProfileCode | null) ?? null;

  return {
    cefrTarget,
    assessments: assessments.map((r) => ({
      id: r.id,
      skill: r.skill as AllocationSkill,
      cefrLevel: r.cefrLevel as CefrLevel,
      assessmentType: r.assessmentType as AssessmentType,
      score: r.score,
      assessDate: r.assessDate,
      assessor: r.assessor as AssessorKind,
      confidence: r.confidence,
      note: r.note,
    })),
    gate,
    milestones: (geGoal?.milestones ?? []).map((m) => ({
      id: m.id,
      milestoneCode: m.milestoneCode,
      title: m.title,
      description: m.description,
      target: m.target,
      status: m.status as MilestoneRowDto['status'],
      completedAt: m.completedAt?.toISOString().slice(0, 10) ?? null,
    })),
    allocation: {
      minutes,
      target: profileCode ? defaultAllocationFor(profileCode) : null,
      profileCode,
    },
  };
}

/** 雅思轨道总览：目标 + IELTS gate + 里程碑 + 趋势。 */
export async function getIeltsOverview(): Promise<{
  target: {
    overall: number;
    listening: number | null;
    reading: number | null;
    writing: number | null;
    speaking: number | null;
  };
  records: IeltsAssessmentDto[];
  gate: TrackGateResult;
  milestones: MilestoneRowDto[];
  /** 有效成绩条数（OFFICIAL/MOCK），与 gate 口径一致。 */
  validRecordCount: number;
  /** 判定所需最少条数。 */
  minRecords: number;
  /** 判定窗口（最近 N 次）。 */
  maxRecords: number;
}> {
  const [profile, ieltsGoal, records] = await Promise.all([
    prisma.userProfile.findUnique({ where: { id: 1 } }),
    prisma.learningGoal.findUnique({
      where: { goalType: 'IELTS' },
      include: { milestones: { orderBy: { sortOrder: 'asc' } } },
    }),
    prisma.ieltsAssessment.findMany({ orderBy: { testDate: 'asc' } }),
  ]);

  const target = {
    overall:
      ieltsGoal?.targetValue ? Number(ieltsGoal.targetValue) || (profile?.targetBandOverall ?? 6.5) : (profile?.targetBandOverall ?? 6.5),
    listening: ieltsGoal?.minListening ?? profile?.targetBandListen ?? null,
    reading: ieltsGoal?.minReading ?? profile?.targetBandRead ?? null,
    writing: ieltsGoal?.minWriting ?? profile?.targetBandWrite ?? null,
    speaking: ieltsGoal?.minSpeaking ?? profile?.targetBandSpeak ?? null,
  };

  const evidence = records.map((r) => ({
    testDate: r.testDate,
    testType: r.testType,
    overallBand: r.overallBand,
    listeningBand: r.listeningBand,
    readingBand: r.readingBand,
    writingBand: r.writingBand,
    speakingBand: r.speakingBand,
  }));

  const gate = evaluateIeltsGate({ records: evidence, target });

  const validRecordCount = records.filter((r) => r.testType === 'OFFICIAL' || r.testType === 'MOCK').length;

  return {
    target,
    records: records.map((r) => ({
      id: r.id,
      testDate: r.testDate,
      testType: r.testType as IeltsTestType,
      overallBand: r.overallBand,
      listeningBand: r.listeningBand,
      readingBand: r.readingBand,
      writingBand: r.writingBand,
      speakingBand: r.speakingBand,
      source: r.source,
      notes: r.notes,
    })),
    gate,
    milestones: (ieltsGoal?.milestones ?? []).map((m) => ({
      id: m.id,
      milestoneCode: m.milestoneCode,
      title: m.title,
      description: m.description,
      target: m.target,
      status: m.status as MilestoneRowDto['status'],
      completedAt: m.completedAt?.toISOString().slice(0, 10) ?? null,
    })),
    validRecordCount,
    minRecords: IELTS_GATE_MIN_RECORDS,
    maxRecords: IELTS_GATE_MAX_RECORDS,
  };
}
