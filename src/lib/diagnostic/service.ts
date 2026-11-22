/**
 * 诊断域服务：会话、作答、评分、快照、报告与计划草案。
 *
 * 硬约束：
 * 1. 原始作答只写一次；重试由唯一键与 clientRequestId 去重。
 * 2. 技术无效的作答不产生 EvidenceRecord，也不计分。
 * 3. 报告 append-only：同一会话只生成一次，补测创建新会话/新报告。
 * 4. 计划只是 DRAFT，用户确认后仅标记 ACTIVE，不自动创建 PlanTask。
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { EvidenceSkill } from '@/lib/types';
import {
  DIAGNOSTIC_AUX_SKILLS,
  DIAGNOSTIC_CORE_SKILLS,
  DIAGNOSTIC_SKILLS,
  DIAG_AUDIO_MAX_BYTES,
  DIAG_DISCLAIMER_ZH,
  DIAG_MIN_WORDS_OPEN,
  type DiagnosticSkill,
} from './constants';
import { ensureDiagnosticBank, pickInitialItemCodes } from './bank';
import {
  buildReportDraft,
  decideNextObjectiveItem,
  estimateSkillProfile,
  levelBelow,
  scoreObjectiveItem,
  type SkillSample,
} from './routing';
import { buildPlanDraft, type PlanProfileInput } from './plan';
import { evaluateOpenResponse } from './ai';

export interface DiagnosticDb {
  prisma: PrismaClient;
}

export interface CreateSessionInput {
  includeEmlr: boolean;
  goals: string[];
  background: Record<string, unknown>;
}

const EVIDENCE_SKILL_MAP: Record<DiagnosticSkill, EvidenceSkill | null> = {
  LISTENING: 'LISTENING',
  READING: 'READING',
  SPEAKING: 'SPEAKING',
  WRITING: 'WRITING',
  GRAMMAR: 'GRAMMAR',
  VOCABULARY: 'VOCABULARY',
  SENTENCE_STRUCTURE: 'GRAMMAR',
  EMLR: null,
};

interface PlanState {
  includeEmlr: boolean;
  queue: string[];
  routing: Array<{ itemId: string; rationale: string }>;
}

function removeFirst(queue: string[], itemId: string): string[] {
  const index = queue.indexOf(itemId);
  if (index < 0) return [...queue];
  return [...queue.slice(0, index), ...queue.slice(index + 1)];
}

function parsePlan(raw: string | null): PlanState {
  if (!raw) return { includeEmlr: false, queue: [], routing: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<PlanState>;
    return {
      includeEmlr: Boolean(parsed.includeEmlr),
      queue: Array.isArray(parsed.queue) ? parsed.queue.filter((id) => typeof id === 'string') : [],
      routing: Array.isArray(parsed.routing) ? parsed.routing : [],
    };
  } catch {
    return { includeEmlr: false, queue: [], routing: [] };
  }
}

function skillLabel(skill: DiagnosticSkill): string {
  return skill;
}

/** 创建会话：写入学习者背景快照，只选取题库中的基础题。 */
export async function createDiagnosticSession(
  prisma: PrismaClient,
  input: CreateSessionInput,
): Promise<{ sessionId: string }> {
  const { blueprintId } = await ensureDiagnosticBank(prisma);
  const codes = pickInitialItemCodes(input.includeEmlr);
  const items = await prisma.diagnosticItem.findMany({
    where: { itemCode: { in: codes }, active: true },
    select: { id: true, itemCode: true },
  });
  const byCode = new Map(items.map((item) => [item.itemCode, item.id]));
  const queue = codes.map((code) => byCode.get(code)).filter((id): id is string => Boolean(id));
  if (queue.length === 0) throw new Error('诊断题库为空，请先初始化题库');

  const plan: PlanState = { includeEmlr: input.includeEmlr, queue, routing: [] };

  const profile = await prisma.learnerProfile.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      goalsJson: JSON.stringify(input.goals),
      backgroundJson: JSON.stringify(input.background),
    },
    update: {
      goalsJson: JSON.stringify(input.goals),
      backgroundJson: JSON.stringify(input.background),
    },
  });

  const session = await prisma.diagnosticSession.create({
    data: {
      blueprintId,
      status: 'IN_PROGRESS',
      goalSnapshotJson: JSON.stringify({
        goals: input.goals,
        background: input.background,
        profileId: profile.id,
      }),
      planJson: JSON.stringify(plan),
      currentItemId: queue[0],
      startedAt: new Date(),
      lastActivityAt: new Date(),
    },
  });

  await prisma.diagnosticItem.updateMany({
    where: { id: { in: queue } },
    data: { exposureCount: { increment: 1 } },
  });

  return { sessionId: session.id };
}

export interface SubmitAttemptInput {
  sessionId: string;
  itemId: string;
  responseText: string;
  timeSpentSec?: number;
  technicalFailed?: boolean;
  technicalReason?: string;
  clientRequestId?: string;
  audioDataUrl?: string;
  audioMime?: string;
  audioDurationSec?: number;
}

export type SubmitResult =
  | { ok: true; status: string; nextItemId: string | null; pendingEvaluation: boolean }
  | { ok: false; code: string; message: string };

function requestKeyOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { clientRequestId?: string };
    return parsed.clientRequestId ?? null;
  } catch {
    return null;
  }
}

export async function submitDiagnosticAttempt(
  prisma: PrismaClient,
  input: SubmitAttemptInput,
): Promise<SubmitResult> {
  const session = await prisma.diagnosticSession.findUnique({ where: { id: input.sessionId } });
  if (!session) return { ok: false, code: 'NOT_FOUND', message: '诊断会话不存在' };
  if (session.status === 'COMPLETED' || session.status === 'FINALIZING') {
    return { ok: false, code: 'PRECONDITION', message: '会话已结束，请对新报告发起补测' };
  }
  if (session.status === 'PAUSED') {
    return { ok: false, code: 'PRECONDITION', message: '会话已暂停，请先继续' };
  }

  const item = await prisma.diagnosticItem.findUnique({ where: { id: input.itemId } });
  if (!item || !item.active) return { ok: false, code: 'NOT_FOUND', message: '诊断题目不存在或已停用' };

  const existingAttempts = await prisma.diagnosticAttempt.findMany({
    where: { sessionId: session.id, itemId: item.id },
    orderBy: { sequence: 'asc' },
  });
  // 幂等优先于队列/顺序校验：重放已成功提交的请求必须返回成功，而不是被当前题目拦住。
  if (input.clientRequestId) {
    const duplicated = existingAttempts.some(
      (attempt) => requestKeyOf(attempt.technicalStatusJson) === input.clientRequestId,
    );
    if (duplicated) {
      return {
        ok: true,
        status: 'SCORED',
        nextItemId: session.currentItemId,
        pendingEvaluation: false,
      };
    }
  }

  const plan = parsePlan(session.planJson);
  if (!plan.queue.includes(item.id)) {
    return { ok: false, code: 'PRECONDITION', message: '该题不在本轮队列中（可能已作答）' };
  }
  if (session.currentItemId && session.currentItemId !== item.id) {
    return { ok: false, code: 'PRECONDITION', message: '请按顺序完成当前题目' };
  }

  const sequence = existingAttempts.length + 1;
  const technicalStatusJson = JSON.stringify({
    clientRequestId: input.clientRequestId ?? randomUUID(),
    failed: Boolean(input.technicalFailed),
    reason: input.technicalReason ?? null,
    device: 'browser',
  });

  let queue = removeFirst(plan.queue, item.id);

  // 技术无效：不计分、不产生证据，重新排队以便补测。
  if (input.technicalFailed) {
    queue = [...queue, item.id];
    await prisma.$transaction(async (tx) => {
      await tx.diagnosticAttempt.create({
        data: {
          sessionId: session.id,
          itemId: item.id,
          sequence,
          status: 'INVALID',
          responseText: null,
          timeSpentSec: input.timeSpentSec ?? null,
          technicalStatusJson,
          evaluatorType: 'SYSTEM',
          confidence: 'LOW',
          rubricVersion: item.rubricVersion,
        },
      });
      await tx.diagnosticSession.update({
        where: { id: session.id },
        data: {
          planJson: JSON.stringify({ ...plan, queue }),
          currentItemId: queue[0] ?? null,
          lastActivityAt: new Date(),
        },
      });
    });
    return { ok: true, status: 'INVALID', nextItemId: queue[0] ?? null, pendingEvaluation: false };
  }

  const responseText = input.responseText.trim();
  const isOpen = item.taskType === 'OPEN_TASK';
  if (isOpen) {
    const words = responseText.split(/\s+/).filter(Boolean).length;
    if (words < DIAG_MIN_WORDS_OPEN && !input.audioDataUrl) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: `开放任务至少需要 ${DIAG_MIN_WORDS_OPEN} 个词，或提供录音；样本过短无法评估`,
      };
    }
  } else if (!responseText) {
    return { ok: false, code: 'VALIDATION', message: '请先作答' };
  }

  if (input.audioDataUrl && input.audioDataUrl.length > DIAG_AUDIO_MAX_BYTES) {
    return { ok: false, code: 'VALIDATION', message: '音频过大（上限约 1.5MB / 90 秒），请缩短或标记技术无效' };
  }

  // ── 客观题：确定性判分 ─────────────────────────────────────
  if (!isOpen) {
    const scored = scoreObjectiveItem(item, responseText);
    if (!scored) return { ok: false, code: 'PRECONDITION', message: '该题不是客观题' };
    const level = scored.correct ? item.targetLevelMax : levelBelow(item.targetLevelMax);

    const outcome = await prisma.$transaction(async (tx) => {
      const attempt = await tx.diagnosticAttempt.create({
        data: {
          sessionId: session.id,
          itemId: item.id,
          sequence,
          status: 'SCORED',
          responseText,
          timeSpentSec: input.timeSpentSec ?? null,
          technicalStatusJson,
          score: scored.score,
          maxScore: scored.maxScore,
          evaluatorType: 'DETERMINISTIC',
          confidence: 'MEDIUM',
          rubricVersion: 'objective.v1',
        },
      });

      const evidenceSkill = EVIDENCE_SKILL_MAP[item.skill as DiagnosticSkill];
      if (evidenceSkill) {
        const evidence = await tx.evidenceRecord.create({
          data: {
            skill: evidenceSkill,
            evidenceType: 'BASELINE',
            level: 'QUICK',
            conditionJson: JSON.stringify({
              source: 'v2.4.1-diagnostic',
              sessionId: session.id,
              itemCode: item.itemCode,
              subskill: item.subskill,
              taskType: item.taskType,
              timeSpentSec: input.timeSpentSec ?? null,
              blueprintVersion: '1.0',
            }),
            outputText: responseText.slice(0, 4000),
            score: scored.score,
            dimensionsJson: JSON.stringify({ subskill: item.subskill, correct: scored.correct }),
            evidenceAnchor: item.itemCode,
            assistanceLevel: 'A0',
            assessorType: 'EXAM',
            confidence: 'MEDIUM',
            privacyLevel: 'PRIVATE',
            note: '系统按已验证题库自动判分（非官方考试）',
          },
        });
        await tx.diagnosticAttempt.update({
          where: { id: attempt.id },
          data: { evidenceId: evidence.id },
        });
      }

      let updatedQueue = [...queue];
      const skillAttemptCount = await tx.diagnosticAttempt.count({
        where: {
          sessionId: session.id,
          status: { not: 'INVALID' },
          item: { skill: item.skill },
        },
      });
      const decision = decideNextObjectiveItem({
        items: await tx.diagnosticItem.findMany({
          where: { active: true, blueprintId: item.blueprintId },
          select: {
            id: true,
            itemCode: true,
            skill: true,
            difficulty: true,
            sourceType: true,
            active: true,
          },
        }),
        skill: item.skill as DiagnosticSkill,
        attemptedCount: skillAttemptCount,
        lastDifficulty: item.difficulty,
        lastCorrect: scored.correct,
        seenItemIds: [
          ...(await tx.diagnosticAttempt.findMany({
            where: { sessionId: session.id },
            select: { itemId: true },
          })).map((row) => row.itemId),
          item.id,
        ],
      });

      if (decision.itemId) {
        // 自适应平行题紧跟当前题之后（队首），保证下一题就验证难度判断。
        updatedQueue = [decision.itemId, ...updatedQueue];
        await tx.diagnosticItem.update({
          where: { id: decision.itemId },
          data: { exposureCount: { increment: 1 } },
        });
      }

      await tx.diagnosticSession.update({
        where: { id: session.id },
        data: {
          planJson: JSON.stringify({
            ...plan,
            queue: updatedQueue,
            routing: [...plan.routing, { itemId: item.id, rationale: decision.rationale }],
          }),
          currentItemId: updatedQueue[0] ?? null,
          lastActivityAt: new Date(),
        },
      });

      return { attemptId: attempt.id, nextItemId: updatedQueue[0] ?? null };
    });

    return {
      ok: true,
      status: 'SCORED',
      nextItemId: outcome.nextItemId,
      pendingEvaluation: false,
    };
  }

  // ── 开放任务：先落原始作答，再尝试 AI 评估 ────────────────────
  const attempt = await prisma.diagnosticAttempt.create({
    data: {
      sessionId: session.id,
      itemId: item.id,
      sequence,
      status: 'PENDING_EVAL',
      responseText,
      timeSpentSec: input.timeSpentSec ?? null,
      technicalStatusJson,
      evaluatorType: 'AI',
      confidence: 'LOW',
      rubricVersion: item.rubricVersion,
    },
  });

  if (input.audioDataUrl) {
    await prisma.diagnosticAsset.create({
      data: {
        attemptId: attempt.id,
        kind: 'AUDIO',
        storagePath: input.audioDataUrl,
        mimeType: input.audioMime ?? 'audio/webm',
        sizeBytes: Buffer.byteLength(input.audioDataUrl, 'utf8'),
        durationSec: input.audioDurationSec ?? null,
      },
    });
  }

  const rubric = item.rubricJson ? JSON.parse(item.rubricJson) as { dimensions: Array<{ labelZh: string; descriptor: string }> } : { dimensions: [] };
  const rubricSummary = rubric.dimensions
    .map((dimension) => `${dimension.labelZh}：${dimension.descriptor}`)
    .join('；');
  const learnerProfile = await prisma.learnerProfile.findUnique({ where: { id: 'default' } });

  const evaluation = await evaluateOpenResponse({
    prisma,
    kind: item.skill === 'SPEAKING' ? 'diag_speaking' : 'diag_writing',
    itemPrompt: item.prompt,
    rubricSummary,
    learnerAnswer: responseText,
    learnerBackground: learnerProfile?.backgroundJson ?? undefined,
  });

  if (!evaluation.ok) {
    await prisma.diagnosticAttempt.update({
      where: { id: attempt.id },
      data: { status: 'NEEDS_REVIEW' },
    });
    const updatedQueue = queue;
    await prisma.diagnosticSession.update({
      where: { id: session.id },
      data: {
        planJson: JSON.stringify({ ...plan, queue: updatedQueue }),
        currentItemId: updatedQueue[0] ?? null,
        lastActivityAt: new Date(),
      },
    });
    return {
      ok: true,
      status: 'NEEDS_REVIEW',
      nextItemId: updatedQueue[0] ?? null,
      pendingEvaluation: true,
    };
  }

  const data = evaluation.data;
  const avg = data.dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / data.dimensions.length;
  const score = Math.max(0, Math.min(2, Math.round(avg)));

  await prisma.$transaction(async (tx) => {
    await tx.assessmentResult.create({
      data: {
        attemptId: attempt.id,
        skill: item.skill,
        subskill: item.subskill,
        dimensionJson: JSON.stringify(data.dimensions),
        estimatedLevel: data.estimated_level,
        levelRangeJson: JSON.stringify(data.level_range),
        confidence: data.confidence,
        rubricVersion: item.rubricVersion,
        evidenceRefsJson: JSON.stringify(data.dimensions.map((dimension) => dimension.evidence).filter(Boolean)),
        limitationsJson: JSON.stringify([data.limitations]),
        needsFollowUp: data.needs_follow_up,
        assessorType: 'AI',
      },
    });

    await tx.diagnosticAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'SCORED',
        score,
        maxScore: 2,
        confidence: data.confidence,
      },
    });

    const evidenceSkill = EVIDENCE_SKILL_MAP[item.skill as DiagnosticSkill];
    if (evidenceSkill) {
      const evidence = await tx.evidenceRecord.create({
        data: {
          skill: evidenceSkill,
          evidenceType: 'BASELINE',
          level: 'QUICK',
          conditionJson: JSON.stringify({
            source: 'v2.4.1-diagnostic',
            sessionId: session.id,
            itemCode: item.itemCode,
            subskill: item.subskill,
            taskType: item.taskType,
            rubricVersion: item.rubricVersion,
            hasAudio: Boolean(input.audioDataUrl),
          }),
          outputText: responseText.slice(0, 4000),
          score,
          dimensionsJson: JSON.stringify(data.dimensions),
          evidenceAnchor: item.itemCode,
          assistanceLevel: 'A0',
          assessorType: 'AI',
          confidence: data.confidence,
          privacyLevel: 'PRIVATE',
          note: `${DIAG_DISCLAIMER_ZH}（AI 辅助评估）`,
        },
      });
      await tx.diagnosticAttempt.update({
        where: { id: attempt.id },
        data: { evidenceId: evidence.id },
      });
    }

    await tx.diagnosticSession.update({
      where: { id: session.id },
      data: {
        planJson: JSON.stringify({ ...plan, queue }),
        currentItemId: queue[0] ?? null,
        lastActivityAt: new Date(),
      },
    });
  });

  return { ok: true, status: 'SCORED', nextItemId: queue[0] ?? null, pendingEvaluation: false };
}

export async function setSessionPaused(
  prisma: PrismaClient,
  sessionId: string,
  paused: boolean,
): Promise<SubmitResult> {
  const session = await prisma.diagnosticSession.findUnique({ where: { id: sessionId } });
  if (!session) return { ok: false, code: 'NOT_FOUND', message: '诊断会话不存在' };
  if (session.status === 'COMPLETED') {
    return { ok: false, code: 'PRECONDITION', message: '会话已完成' };
  }
  await prisma.diagnosticSession.update({
    where: { id: sessionId },
    data: { status: paused ? 'PAUSED' : 'IN_PROGRESS', lastActivityAt: new Date() },
  });
  return { ok: true, status: paused ? 'PAUSED' : 'IN_PROGRESS', nextItemId: session.currentItemId, pendingEvaluation: false };
}

/** 生成快照、报告与计划草案；幂等：已存在报告直接返回。 */
export async function finalizeDiagnosticSession(
  prisma: PrismaClient,
  sessionId: string,
): Promise<{ ok: true; reportId: string; provisional: boolean } | { ok: false; code: string; message: string }> {
  const session = await prisma.diagnosticSession.findUnique({
    where: { id: sessionId },
    include: {
      report: true,
      attempts: { include: { item: true, assessment: true } },
    },
  });
  if (!session) return { ok: false, code: 'NOT_FOUND', message: '诊断会话不存在' };
  if (session.report) {
    return { ok: true, reportId: session.report.id, provisional: session.report.status === 'PROVISIONAL' };
  }
  if (session.attempts.length === 0) {
    return { ok: false, code: 'PRECONDITION', message: '还没有任何作答，无法生成报告' };
  }

  await prisma.diagnosticSession.update({
    where: { id: session.id },
    data: { status: 'FINALIZING' },
  });

  const scored = session.attempts.filter((attempt) => attempt.status === 'SCORED');
  const pending = session.attempts.filter(
    (attempt) => attempt.status === 'NEEDS_REVIEW' || attempt.status === 'PENDING_EVAL',
  );

  const samplesBySkill = new Map<DiagnosticSkill, SkillSample[]>();
  for (const attempt of scored) {
    const skill = attempt.item.skill as DiagnosticSkill;
    const list = samplesBySkill.get(skill) ?? [];
    if (attempt.item.taskType === 'OPEN_TASK') {
      list.push({
        skill,
        subskill: attempt.item.subskill,
        level: attempt.assessment?.estimatedLevel ?? levelBelow(attempt.item.targetLevelMax),
        confidence: (attempt.assessment?.confidence as 'LOW' | 'MEDIUM' | 'HIGH') ?? 'LOW',
        sourceType: 'RUBRIC',
      });
    } else {
      const correct = (attempt.score ?? 0) >= 2;
      list.push({
        skill,
        subskill: attempt.item.subskill,
        level: correct ? attempt.item.targetLevelMax : levelBelow(attempt.item.targetLevelMax),
        confidence: 'MEDIUM',
        sourceType: 'VERIFIED',
      });
    }
    samplesBySkill.set(skill, list);
  }
  for (const attempt of pending) {
    const skill = attempt.item.skill as DiagnosticSkill;
    const list = samplesBySkill.get(skill) ?? [];
    list.push({
      skill,
      subskill: attempt.item.subskill,
      level: 'A1',
      confidence: 'LOW',
      sourceType: 'RUBRIC',
      pending: true,
    });
    samplesBySkill.set(skill, list);
  }

  const allItems = await prisma.diagnosticItem.findMany({
    where: { active: true },
    select: { skill: true, subskill: true },
  });
  const expectedBySkill = new Map<string, string[]>();
  for (const item of allItems) {
    const list = expectedBySkill.get(item.skill) ?? [];
    if (!list.includes(item.subskill)) list.push(item.subskill);
    expectedBySkill.set(item.skill, list);
  }

  const skillsToProfile: DiagnosticSkill[] = [
    ...DIAGNOSTIC_CORE_SKILLS,
    ...DIAGNOSTIC_AUX_SKILLS,
  ];
  if (samplesBySkill.has('EMLR')) skillsToProfile.push('EMLR');

  const profiles = skillsToProfile.map((skill) =>
    estimateSkillProfile(skill, samplesBySkill.get(skill) ?? [], expectedBySkill.get(skill) ?? []),
  );

  for (const profile of profiles) {
    await prisma.skillProfileSnapshot.upsert({
      where: { sessionId_skill: { sessionId: session.id, skill: profile.skill } },
      create: {
        sessionId: session.id,
        skill: profile.skill,
        estimatedLevel: profile.estimatedLevel,
        levelRangeJson: JSON.stringify(profile.levelRange),
        confidence: profile.confidence,
        coverageJson: JSON.stringify({
          ratio: profile.coverageRatio,
          subskills: profile.subskills,
          expectedSubskills: expectedBySkill.get(profile.skill) ?? [],
        }),
        evidenceCount: profile.evidenceCount,
        limitationsJson: JSON.stringify(profile.limitations),
        needsFollowUp: profile.needsFollowUp,
      },
      update: {
        estimatedLevel: profile.estimatedLevel,
        levelRangeJson: JSON.stringify(profile.levelRange),
        confidence: profile.confidence,
        coverageJson: JSON.stringify({
          ratio: profile.coverageRatio,
          subskills: profile.subskills,
          expectedSubskills: expectedBySkill.get(profile.skill) ?? [],
        }),
        evidenceCount: profile.evidenceCount,
        limitationsJson: JSON.stringify(profile.limitations),
        needsFollowUp: profile.needsFollowUp,
      },
    });
  }

  const draft = buildReportDraft(profiles, skillLabel, pending.length);

  const planner = await prisma.plannerSettings.findUnique({ where: { id: 1 } });
  let weekdayProfiles: number[] = [60, 60, 60, 60, 60, 60, 0];
  try {
    if (planner?.weekdayProfiles) {
      const parsed = JSON.parse(planner.weekdayProfiles) as unknown;
      if (Array.isArray(parsed) && parsed.length === 7) {
        weekdayProfiles = parsed.map((value) => (typeof value === 'number' ? value : 0));
      }
    }
  } catch {
    // 配置损坏时回落初始建议值；不因此阻断诊断报告。
  }

  const planProfiles: PlanProfileInput[] = profiles.map((profile) => ({
    skill: profile.skill,
    estimatedLevel: profile.estimatedLevel,
    levelRange: profile.levelRange,
    confidence: profile.confidence,
    needsFollowUp: profile.needsFollowUp,
    evidenceCount: profile.evidenceCount,
  }));
  const plan = buildPlanDraft(planProfiles, {
    weeklyTargetMinutes: planner?.weeklyTargetMinutes ?? null,
    weekdayProfiles,
    defaultDailyMinutes: planner?.defaultDailyMinutes ?? 60,
    isUserConfirmed: planner?.isUserConfirmed ?? false,
  });

  const reportId = await prisma.$transaction(async (tx) => {
    const report = await tx.placementReport.create({
      data: {
        sessionId: session.id,
        version: 1,
        status: draft.provisional ? 'PROVISIONAL' : 'FINAL',
        summary: draft.summary,
        strengthsJson: JSON.stringify(draft.strengths),
        gapsJson: JSON.stringify(draft.gaps),
        coverageJson: JSON.stringify(
          profiles.map((profile) => ({
            skill: profile.skill,
            evidenceCount: profile.evidenceCount,
            coverageRatio: profile.coverageRatio,
            subskills: profile.subskills,
          })),
        ),
        suggestionsJson: JSON.stringify([
          ...draft.suggestions,
          ...profiles.filter((profile) => profile.needsFollowUp).map(
            (profile) => `补测建议：${profile.skill}（${profile.limitations[0] ?? '样本不足'}）`,
          ),
        ]),
        confidence: draft.confidence,
        limitationsJson: JSON.stringify(draft.limitations),
      },
    });

    await tx.planProposal.create({
      data: {
        reportId: report.id,
        status: 'DRAFT',
        horizonDays: 90,
        tasksJson: JSON.stringify(plan.phases),
        rationaleJson: JSON.stringify(plan.rationale),
        budgetJson: JSON.stringify(plan.budget),
      },
    });

    await tx.diagnosticSession.update({
      where: { id: session.id },
      data: { status: 'COMPLETED', completedAt: new Date(), lastActivityAt: new Date() },
    });

    return report.id;
  });

  return { ok: true, reportId, provisional: draft.provisional };
}

export async function activatePlanProposal(
  prisma: PrismaClient,
  proposalId: string,
  editedPhases?: unknown,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const proposal = await prisma.planProposal.findUnique({ where: { id: proposalId } });
  if (!proposal) return { ok: false, code: 'NOT_FOUND', message: '计划草案不存在' };
  if (proposal.status === 'ACTIVE') return { ok: true };

  await prisma.planProposal.update({
    where: { id: proposalId },
    data: {
      status: 'ACTIVE',
      activatedAt: new Date(),
      ...(editedPhases ? { tasksJson: JSON.stringify(editedPhases) } : {}),
    },
  });
  return { ok: true };
}

export async function requestDiagnosticReview(
  prisma: PrismaClient,
  reportId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const report = await prisma.placementReport.findUnique({ where: { id: reportId } });
  if (!report) return { ok: false, code: 'NOT_FOUND', message: '报告不存在' };
  await prisma.diagnosticReviewRequest.create({
    data: { reportId, reason: reason.slice(0, 1000), status: 'OPEN' },
  });
  return { ok: true };
}

/** 补测：创建新会话；旧报告保留，新报告不覆盖。 */
export async function createRetestSession(
  prisma: PrismaClient,
  reportId: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }> {
  const report = await prisma.placementReport.findUnique({
    where: { id: reportId },
    include: { session: true },
  });
  if (!report) return { ok: false, code: 'NOT_FOUND', message: '报告不存在' };
  const goal = report.session.goalSnapshotJson
    ? (JSON.parse(report.session.goalSnapshotJson) as { goals?: string[]; background?: Record<string, unknown> })
    : {};
  const plan = parsePlan(report.session.planJson);
  const created = await createDiagnosticSession(prisma, {
    includeEmlr: plan.includeEmlr,
    goals: goal.goals ?? [],
    background: goal.background ?? {},
  });
  return { ok: true, sessionId: created.sessionId };
}

/** 删除会话及其证据与原始音频；用于隐私删除。 */
export async function deleteDiagnosticSession(
  prisma: PrismaClient,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const attempts = await prisma.diagnosticAttempt.findMany({
    where: { sessionId },
    select: { evidenceId: true },
  });
  const evidenceIds = attempts.map((attempt) => attempt.evidenceId).filter((id): id is string => Boolean(id));

  await prisma.$transaction(async (tx) => {
    if (evidenceIds.length > 0) {
      await tx.evidenceRecord.deleteMany({ where: { id: { in: evidenceIds } } });
    }
    await tx.diagnosticSession.delete({ where: { id: sessionId } });
  });
  return { ok: true };
}

export function isDiagnosticSkill(value: string): value is DiagnosticSkill {
  return (DIAGNOSTIC_SKILLS as readonly string[]).includes(value);
}