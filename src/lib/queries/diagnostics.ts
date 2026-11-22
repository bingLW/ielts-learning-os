/** v2.4.1 诊断只读查询（DTO 必须可序列化，不向前端泄露未作答题的答案）。 */

import { prisma } from '@/lib/prisma';
import type { DiagnosticSkill } from '@/lib/diagnostic/constants';
import { DIAGNOSTIC_SKILL_LABEL_ZH } from '@/lib/diagnostic/constants';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface DiagnosticItemDto {
  id: string;
  itemCode: string;
  skill: DiagnosticSkill;
  skillLabel: string;
  subskill: string;
  taskType: string;
  sourceType: string;
  difficulty: number;
  prompt: string;
  passage: string | null;
  transcript: string | null;
  options: Array<{ key: string; text: string }>;
  rubric: Array<{ id: string; labelZh: string; descriptor: string }>;
  timingNote: string;
}

export interface DiagnosticAttemptDto {
  id: string;
  itemId: string;
  itemCode: string;
  skill: DiagnosticSkill;
  skillLabel: string;
  subskill: string;
  status: string;
  score: number | null;
  responseText: string | null;
  timeSpentSec: number | null;
  hasAudio: boolean;
  dimensions: Array<{ criterion: string; score: number; evidence: string; comment?: string }>;
  estimatedLevel: string | null;
  levelRange: [string, string] | null;
  confidence: string | null;
  limitations: string[];
  needsFollowUp: boolean;
  submittedAt: string;
}

export interface DiagnosticSessionDto {
  id: string;
  status: string;
  createdAt: string;
  lastActivityAt: string | null;
  progress: { answered: number; plannedRemaining: number; totalSeen: number };
  reportId: string | null;
  includeEmlr: boolean;
  currentItem: DiagnosticItemDto | null;
  attempts: DiagnosticAttemptDto[];
  routing: Array<{ itemId: string; rationale: string }>;
}

function toItemDto(item: {
  id: string;
  itemCode: string;
  skill: string;
  subskill: string;
  taskType: string;
  sourceType: string;
  difficulty: number;
  prompt: string;
  passage: string | null;
  transcript: string | null;
  optionsJson: string | null;
  rubricJson: string | null;
}): DiagnosticItemDto {
  const skill = item.skill as DiagnosticSkill;
  return {
    id: item.id,
    itemCode: item.itemCode,
    skill,
    skillLabel: DIAGNOSTIC_SKILL_LABEL_ZH[skill] ?? item.skill,
    subskill: item.subskill,
    taskType: item.taskType,
    sourceType: item.sourceType,
    difficulty: item.difficulty,
    prompt: item.prompt,
    passage: item.passage,
    transcript: item.transcript,
    options: parseJson(item.optionsJson, []),
    rubric: parseJson(item.rubricJson, { dimensions: [] }).dimensions ?? [],
    timingNote:
      item.taskType === 'OPEN_TASK'
        ? '保留第一版作答；系统不以你提交后的修改作为基线。'
        : '不查词典；客观题按题库答案判分。',
  };
}

export async function listDiagnosticSessions(): Promise<
  Array<{
    id: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    reportId: string | null;
    reportStatus: string | null;
  }>
> {
  const rows = await prisma.diagnosticSession.findMany({
    orderBy: { createdAt: 'desc' },
    include: { report: { select: { id: true, status: true } } },
    take: 30,
  });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    reportId: row.report?.id ?? null,
    reportStatus: row.report?.status ?? null,
  }));
}

export async function getDiagnosticSessionDetail(
  sessionId: string,
): Promise<DiagnosticSessionDto | null> {
  const session = await prisma.diagnosticSession.findUnique({
    where: { id: sessionId },
    include: {
      report: { select: { id: true } },
      attempts: {
        include: {
          item: true,
          assessment: true,
          assets: { select: { id: true } },
        },
        orderBy: { submittedAt: 'asc' },
      },
    },
  });
  if (!session) return null;

  const plan = parseJson<{ includeEmlr?: boolean; queue?: string[]; routing?: Array<{ itemId: string; rationale: string }> }>(
    session.planJson,
    {},
  );

  let currentItem: DiagnosticItemDto | null = null;
  if (session.currentItemId && session.status !== 'COMPLETED') {
    const item = await prisma.diagnosticItem.findUnique({ where: { id: session.currentItemId } });
    if (item) currentItem = toItemDto(item);
  } else if (session.status !== 'COMPLETED' && (plan.queue ?? []).length > 0) {
    const item = await prisma.diagnosticItem.findUnique({ where: { id: plan.queue![0] } });
    if (item) currentItem = toItemDto(item);
  }

  const attempts: DiagnosticAttemptDto[] = session.attempts.map((attempt) => ({
    id: attempt.id,
    itemId: attempt.itemId,
    itemCode: attempt.item.itemCode,
    skill: attempt.item.skill as DiagnosticSkill,
    skillLabel:
      DIAGNOSTIC_SKILL_LABEL_ZH[attempt.item.skill as DiagnosticSkill] ?? attempt.item.skill,
    subskill: attempt.item.subskill,
    status: attempt.status,
    score: attempt.score,
    responseText: attempt.responseText,
    timeSpentSec: attempt.timeSpentSec,
    hasAudio: attempt.assets.length > 0,
    dimensions: parseJson<Array<{ criterion: string; score: number; evidence: string; comment?: string }>>(
      attempt.assessment?.dimensionJson,
      [],
    ),
    estimatedLevel: attempt.assessment?.estimatedLevel ?? null,
    levelRange: parseJson<[string, string] | null>(attempt.assessment?.levelRangeJson, null),
    confidence: attempt.assessment?.confidence ?? attempt.confidence,
    limitations: parseJson<string[]>(attempt.assessment?.limitationsJson, []),
    needsFollowUp: attempt.assessment?.needsFollowUp ?? false,
    submittedAt: attempt.submittedAt.toISOString(),
  }));

  return {
    id: session.id,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt?.toISOString() ?? null,
    progress: {
      answered: attempts.filter((attempt) => attempt.status !== 'INVALID').length,
      plannedRemaining: (plan.queue ?? []).length,
      totalSeen: attempts.length,
    },
    reportId: session.report?.id ?? null,
    includeEmlr: Boolean(plan.includeEmlr),
    currentItem,
    attempts,
    routing: plan.routing ?? [],
  };
}

export interface DiagnosticReportDto {
  id: string;
  sessionId: string;
  status: string;
  confidence: string;
  summary: string;
  strengths: string[];
  gaps: string[];
  suggestions: string[];
  limitations: string[];
  createdAt: string;
  snapshots: Array<{
    skill: DiagnosticSkill;
    skillLabel: string;
    estimatedLevel: string | null;
    levelRange: [string, string] | null;
    confidence: string;
    evidenceCount: number;
    coverageRatio: number;
    needsFollowUp: boolean;
    limitations: string[];
  }>;
  attempts: DiagnosticAttemptDto[];
  proposal: {
    id: string;
    status: string;
    budget: { weeklyMinutes: number; dailyAverage: number; source: string } | null;
    phases: Array<{
      window: string;
      focus: string;
      tasks: Array<{ title: string; minutes: number; skill: string; evidenceRef: string; reason: string }>;
    }>;
    notes: string[];
    activatedAt: string | null;
  } | null;
  reviews: Array<{ id: string; status: string; reason: string; createdAt: string }>;
}

export async function getDiagnosticReport(
  reportId: string,
): Promise<DiagnosticReportDto | null> {
  const report = await prisma.placementReport.findUnique({
    where: { id: reportId },
    include: {
      session: {
        include: {
          attempts: {
            include: { item: true, assessment: true, assets: { select: { id: true } } },
            orderBy: { submittedAt: 'asc' },
          },
          snapshots: true,
        },
      },
      proposals: { orderBy: { createdAt: 'desc' } },
      reviewRequests: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!report) return null;

  const attempts: DiagnosticAttemptDto[] = report.session.attempts.map((attempt) => ({
    id: attempt.id,
    itemId: attempt.itemId,
    itemCode: attempt.item.itemCode,
    skill: attempt.item.skill as DiagnosticSkill,
    skillLabel:
      DIAGNOSTIC_SKILL_LABEL_ZH[attempt.item.skill as DiagnosticSkill] ?? attempt.item.skill,
    subskill: attempt.item.subskill,
    status: attempt.status,
    score: attempt.score,
    responseText: attempt.responseText,
    timeSpentSec: attempt.timeSpentSec,
    hasAudio: attempt.assets.length > 0,
    dimensions: parseJson(
      attempt.assessment?.dimensionJson,
      [] as Array<{ criterion: string; score: number; evidence: string; comment?: string }>,
    ),
    estimatedLevel: attempt.assessment?.estimatedLevel ?? null,
    levelRange: parseJson<[string, string] | null>(attempt.assessment?.levelRangeJson, null),
    confidence: attempt.assessment?.confidence ?? attempt.confidence,
    limitations: parseJson<string[]>(attempt.assessment?.limitationsJson, []),
    needsFollowUp: attempt.assessment?.needsFollowUp ?? false,
    submittedAt: attempt.submittedAt.toISOString(),
  }));

  const proposalRow = report.proposals[0] ?? null;
  const proposal = proposalRow
    ? {
        id: proposalRow.id,
        status: proposalRow.status,
        budget: parseJson<{ weeklyMinutes: number; dailyAverage: number; source: string } | null>(
          proposalRow.budgetJson,
          null,
        ),
        phases: parseJson<
          Array<{
            window: string;
            focus: string;
            tasks: Array<{ title: string; minutes: number; skill: string; evidenceRef: string; reason: string }>;
          }>
        >(proposalRow.tasksJson, []),
        notes: parseJson<{ notes?: string[] }>(proposalRow.rationaleJson, {}).notes ?? [],
        activatedAt: proposalRow.activatedAt?.toISOString() ?? null,
      }
    : null;

  return {
    id: report.id,
    sessionId: report.sessionId,
    status: report.status,
    confidence: report.confidence,
    summary: report.summary,
    strengths: parseJson(report.strengthsJson, []),
    gaps: parseJson(report.gapsJson, []),
    suggestions: parseJson(report.suggestionsJson, []),
    limitations: parseJson(report.limitationsJson, []),
    createdAt: report.createdAt.toISOString(),
    snapshots: report.session.snapshots.map((snapshot) => ({
      skill: snapshot.skill as DiagnosticSkill,
      skillLabel: DIAGNOSTIC_SKILL_LABEL_ZH[snapshot.skill as DiagnosticSkill] ?? snapshot.skill,
      estimatedLevel: snapshot.estimatedLevel,
      levelRange: parseJson<[string, string] | null>(snapshot.levelRangeJson, null),
      confidence: snapshot.confidence,
      evidenceCount: snapshot.evidenceCount,
      coverageRatio: parseJson<{ ratio?: number }>(snapshot.coverageJson, {}).ratio ?? 0,
      needsFollowUp: snapshot.needsFollowUp,
      limitations: parseJson<string[]>(snapshot.limitationsJson, []),
    })),
    attempts,
    proposal,
    reviews: report.reviewRequests.map((review) => ({
      id: review.id,
      status: review.status,
      reason: review.reason,
      createdAt: review.createdAt.toISOString(),
    })),
  };
}

/** Dashboard 用：是否已有完成/进行中的基线诊断。 */
export async function getDiagnosticBaselineState(): Promise<{
  activeSessionId: string | null;
  latestReportId: string | null;
  latestReportStatus: string | null;
  completedCount: number;
}> {
  const [active, latestReport, completedCount] = await Promise.all([
    prisma.diagnosticSession.findFirst({
      where: { status: { in: ['CREATED', 'IN_PROGRESS', 'PAUSED', 'FINALIZING'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
    prisma.placementReport.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    }),
    prisma.diagnosticSession.count({ where: { status: 'COMPLETED' } }),
  ]);
  return {
    activeSessionId: active?.id ?? null,
    latestReportId: latestReport?.id ?? null,
    latestReportStatus: latestReport?.status ?? null,
    completedCount,
  };
}
