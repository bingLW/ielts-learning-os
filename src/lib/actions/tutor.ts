'use server';

/**
 * AI Learning Coach 的 Server Actions。
 *
 * 关键约束：
 * - 提示/讲解/练习必须在独立基线保存之后；
 * - 用户原始作答只写入 USER 轮次与证据，AI 输出不得覆盖；
 * - AI 评估写入证据时固定 assessorType=AI，并带免责声明；
 * - 建议进入正式计划或错题本必须经用户确认（这里提供显式确认动作）。
 */

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import {
  AI_ASSESSMENT_DISCLAIMER_ZH,
  AI_CONTEXT_LIMITS,
  type AiCefrLevel,
  type AiSessionStatus,
} from '@/lib/constants';
import { buildLearningContext, renderContextSummary, serializeContext } from '@/lib/ai/context';
import { loadEngineConfig } from '@/lib/ai/config';
import { encryptSecret } from '@/lib/ai/credentials';
import { runAiTurn } from '@/lib/ai/orchestrator';
import { ensurePromptRegistry } from '@/lib/ai/registry';
import {
  canRequestSupport,
  canScheduleDelayedRetest,
  canStartRetest,
  hintLeaksAnswer,
  isTerminal,
  validateHintRequest,
} from '@/lib/ai/state';
import type { AiContextSnapshot, AiPromptMeta } from '@/lib/ai/types';
import type {
  DiagnosisResult,
  DrillSet,
  EvidenceAssessment,
  FeedbackResult,
  HintResult,
  TaskSpec,
} from '@/lib/ai/structured';
import { today } from '@/lib/date';
import { maxEvidenceScore } from '@/lib/domain/evidence';
import { prisma } from '@/lib/prisma';
import { getEffectiveBudget } from '@/lib/queries/budget';
import { getProfile } from '@/lib/queries/profile';
import { getActiveStage } from '@/lib/queries/stages';
import { ensureRetestChain } from '@/lib/retestSchedule';
import { fail, failValidation, ok } from '@/lib/result';
import {
  markTurnFeedbackSchema,
  promoteDiagnosisSchema,
  requestHintSchema,
  requestTurnSchema,
  saveProviderCredentialSchema,
  sessionIdSchema,
  startAiSessionSchema,
  submitBaselineSchema,
  submitRetestSchema,
  updateAiEngineSettingsSchema,
  updateAiModelConfigSchema,
} from '@/lib/schema/tutor';
import type { ActionResult, AssistanceLevel } from '@/lib/types';
import { createMistakeAction } from './mistakes';

function refreshAiPages(sessionId?: string) {
  revalidatePath('/ai-coach');
  revalidatePath('/ai-coach/review');
  revalidatePath('/ai-coach/usage');
  if (sessionId) revalidatePath(`/ai-coach/${sessionId}`);
  revalidatePath('/evidence');
  revalidatePath('/retest');
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function contextSummaryOf(raw: string | null): string {
  const snapshot = parseJson<AiContextSnapshot>(raw);
  return snapshot ? renderContextSummary(snapshot) : '（无）';
}

function taskSpecOf(raw: string | null): TaskSpec | null {
  return parseJson<TaskSpec>(raw);
}

function normalizeLevel(value: string | null | undefined): AiCefrLevel {
  if (!value) return 'A1';
  if (value === 'Pre-A1') return 'A1';
  const allowed: readonly string[] = ['A0', 'A1', 'A2', 'B1', 'B2', 'C1'];
  return allowed.includes(value) ? (value as AiCefrLevel) : 'A1';
}

function toAssistanceLevel(aidLevel: string | undefined): AssistanceLevel {
  switch (aidLevel) {
    case undefined:
    case 'none':
      return 'A0';
    case 'dictionary':
    case 'transcript':
    case 'translation':
      return 'A1';
    case 'AI_hint':
      return 'A2';
    case 'AI_full_assistance':
      return 'A4';
    default:
      return 'A3';
  }
}

function baseMeta(
  session: {
    mode: string;
    skill: string;
    objective: string;
    targetLevel: string | null;
    baselineText: string | null;
    taskSpecJson: string | null;
    contextJson: string | null;
  },
  extras: Partial<AiPromptMeta> = {},
): AiPromptMeta {
  const task = taskSpecOf(session.taskSpecJson);
  return {
    mode: session.mode as AiPromptMeta['mode'],
    skill: session.skill as AiPromptMeta['skill'],
    objective: session.objective,
    targetLevel: session.targetLevel ?? 'A1',
    baseline: session.baselineText ?? undefined,
    taskInstructions: task?.instructions,
    contextSummary: contextSummaryOf(session.contextJson),
    ...extras,
  };
}

async function maxHintLevelUsed(sessionId: string): Promise<number> {
  const turns = await prisma.aILearningTurn.findMany({
    where: { sessionId, kind: 'HINT' },
    select: { structuredJson: true },
  });
  let max = 0;
  for (const turn of turns) {
    const hint = parseJson<HintResult>(turn.structuredJson);
    if (hint && Number.isFinite(hint.hint_level)) {
      max = Math.max(max, hint.hint_level);
    }
  }
  return max;
}

async function latestDiagnosisSummary(sessionId: string): Promise<string | undefined> {
  const turn = await prisma.aILearningTurn.findFirst({
    where: { sessionId, kind: 'DIAGNOSIS' },
    orderBy: { sequence: 'desc' },
    select: { structuredJson: true },
  });
  const diagnosis = turn ? parseJson<DiagnosisResult>(turn.structuredJson) : null;
  return diagnosis?.summary;
}

async function appendUserTurn(
  tx: Prisma.TransactionClient,
  sessionId: string,
  kind: 'BASELINE' | 'PRACTICE' | 'RETEST',
  text: string,
  clientRequestId: string,
): Promise<string> {
  const maxSequence = await tx.aILearningTurn.aggregate({
    where: { sessionId },
    _max: { sequence: true },
  });
  const turn = await tx.aILearningTurn.create({
    data: {
      sessionId,
      sequence: (maxSequence._max.sequence ?? 0) + 1,
      role: 'USER',
      kind,
      contentText: text,
      clientRequestId,
    },
    select: { id: true },
  });
  return turn.id;
}

export async function startAiSessionAction(
  raw: unknown,
): Promise<
  ActionResult<{
    sessionId: string;
    taskReady: boolean;
    providerMode: 'mock' | 'external';
    warning?: string;
  }>
> {
  const parsed = startAiSessionSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  try {
    await ensurePromptRegistry(prisma);
  } catch (error) {
    return fail('INTERNAL', `提示词初始化失败：${String(error).slice(0, 200)}`);
  }

  const [profile, stage, skillProfile, mistakes, evidenceRows, budget, engine] =
    await Promise.all([
      getProfile(),
      getActiveStage(),
      prisma.skillProfile.findUnique({ where: { skill: input.skill } }),
      prisma.mistake.findMany({
        where: { archivedAt: null },
        orderBy: { createdAt: 'desc' },
        take: AI_CONTEXT_LIMITS.recentErrors,
        select: { errorCategory: true, originalQuestion: true, createdAt: true },
      }),
      prisma.evidenceRecord.findMany({
        where: { skill: input.skill, archivedAt: null },
        orderBy: { createdAt: 'desc' },
        take: AI_CONTEXT_LIMITS.recentEvidence,
        select: { skill: true, evidenceType: true, score: true, createdAt: true },
      }),
      getEffectiveBudget(),
      loadEngineConfig(prisma),
    ]);

  const todayStr = today();
  const planned = await prisma.planTask.aggregate({
    where: { planDate: todayStr, status: { in: ['TODO', 'IN_PROGRESS', 'PARTIAL'] } },
    _sum: { plannedMinutes: true },
  });

  const targetLevel = normalizeLevel(input.targetLevel ?? skillProfile?.direction);
  const snapshot = buildLearningContext({
    track: 'IELTS',
    ieltsTargetNote: `总分目标 ${profile.targetBandOverall}`,
    skill: input.skill,
    profile:
      skillProfile?.direction !== null && skillProfile?.direction !== undefined
        ? { cefrEstimate: skillProfile.direction, confidence: skillProfile.confidence }
        : null,
    stage: stage
      ? { name: stage.nameZh, focus: stage.profileCode ?? stage.code, acceptance: null }
      : null,
    errors: mistakes.map((item) => ({
      category: item.errorCategory,
      summary: item.originalQuestion.slice(0, 120),
      occurredOn: item.createdAt.toISOString().slice(0, 10),
    })),
    evidence: evidenceRows.map((item) => ({
      skill: item.skill,
      evidenceType: item.evidenceType,
      score: item.score,
      createdAt: item.createdAt.toISOString(),
    })),
    explainLanguage: engine.setting.explainLanguage,
    directTeachingAllowed: input.directTeaching ?? engine.setting.directTeachingDefault,
    remainingMinutes: Math.max(0, budget.minutes - (planned._sum.plannedMinutes ?? 0)),
  });

  const registry = await ensurePromptRegistry(prisma, ['task']);
  const session = await prisma.aILearningSession.create({
    data: {
      mode: input.mode,
      skill: input.skill,
      objective: input.objective,
      targetLevel,
      status: 'CREATED',
      promptTemplateKey: 'ai.task.v1',
      promptVersionId: registry.task.versionId,
      modelConfigId: engine.modelConfig.id.startsWith('fallback') ? null : engine.modelConfig.id,
      provider: engine.providerMode === 'mock' ? 'mock' : engine.modelConfig.provider,
      model: engine.modelConfig.model,
      contextJson: serializeContext(snapshot),
      allowedAidsJson: JSON.stringify(input.allowedAids ?? []),
      directTeaching: input.directTeaching ?? engine.setting.directTeachingDefault,
    },
    select: { id: true },
  });

  const turn = await runAiTurn({
    prisma,
    sessionId: session.id,
    promptKind: 'task',
    turnKind: 'TASK',
    clientRequestId: `task-${randomUUID()}`,
    meta: baseMeta(
      {
        mode: input.mode,
        skill: input.skill,
        objective: input.objective,
        targetLevel,
        baselineText: null,
        taskSpecJson: null,
        contextJson: serializeContext(snapshot),
      },
      { contextSummary: renderContextSummary(snapshot), allowedAids: input.allowedAids },
    ),
  });

  if (!turn.ok) {
    refreshAiPages(session.id);
    return ok({
      sessionId: session.id,
      taskReady: false,
      providerMode: engine.providerMode,
      warning: `任务生成失败：${turn.message}。会话已保留，可稍后重试。`,
    });
  }

  const task = turn.structured as TaskSpec;
  await prisma.$transaction([
    prisma.aILearningSession.update({
      where: { id: session.id },
      data: {
        status: 'TASK_PRESENTED',
        taskSpecJson: JSON.stringify(task),
        rubricJson: JSON.stringify(task.rubric),
        promptVersionId: registry.task.versionId,
      },
    }),
    prisma.learningTaskInstance.create({
      data: {
        sessionId: session.id,
        taskSpecJson: JSON.stringify(task),
        source: 'AI',
        estimatedMinutes: task.estimated_minutes,
        allowedAidsJson: JSON.stringify(task.allowed_aids),
        status: 'ACTIVE',
      },
    }),
  ]);

  refreshAiPages(session.id);
  return ok({
    sessionId: session.id,
    taskReady: true,
    providerMode: turn.providerMode,
    warning:
      turn.providerMode === 'mock'
        ? '当前使用内置模拟模型（未配置外部 Provider），输出用于教学流程演示。'
        : undefined,
  });
}

export async function retryTaskAction(
  raw: unknown,
): Promise<ActionResult<{ taskReady: boolean }>> {
  const parsed = sessionIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const session = await prisma.aILearningSession.findUnique({
    where: { id: parsed.data.sessionId },
  });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  if (session.status !== 'CREATED') {
    return fail('PRECONDITION', '只有任务尚未生成时才能重试');
  }

  const registry = await ensurePromptRegistry(prisma, ['task']);
  const turn = await runAiTurn({
    prisma,
    sessionId: session.id,
    promptKind: 'task',
    turnKind: 'TASK',
    clientRequestId: `task-${randomUUID()}`,
    meta: baseMeta(session),
  });
  if (!turn.ok) {
    refreshAiPages(session.id);
    return fail(turn.code === 'BUDGET_EXCEEDED' ? 'PRECONDITION' : 'INTERNAL', turn.message);
  }

  const task = turn.structured as TaskSpec;
  await prisma.$transaction([
    prisma.aILearningSession.update({
      where: { id: session.id },
      data: {
        status: 'TASK_PRESENTED',
        taskSpecJson: JSON.stringify(task),
        rubricJson: JSON.stringify(task.rubric),
        promptVersionId: registry.task.versionId,
        failureReason: null,
      },
    }),
    prisma.learningTaskInstance.create({
      data: {
        sessionId: session.id,
        taskSpecJson: JSON.stringify(task),
        source: 'AI',
        estimatedMinutes: task.estimated_minutes,
        allowedAidsJson: JSON.stringify(task.allowed_aids),
        status: 'ACTIVE',
      },
    }),
  ]);
  refreshAiPages(session.id);
  return ok({ taskReady: true });
}

export async function submitBaselineAction(
  raw: unknown,
): Promise<ActionResult<{ turnId: string; evidenceId: string }>> {
  const parsed = submitBaselineSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const duplicate = await prisma.aILearningTurn.findUnique({
    where: {
      sessionId_clientRequestId: {
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
      },
    },
    select: { id: true },
  });
  if (duplicate) {
    const evidence = await prisma.evidenceRecord.findFirst({
      where: { aiSessionId: input.sessionId, evidenceType: 'BASELINE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return ok({ turnId: duplicate.id, evidenceId: evidence?.id ?? '' });
  }

  const session = await prisma.aILearningSession.findUnique({
    where: { id: input.sessionId },
  });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  if (session.baselineText && session.baselineText.trim().length > 0) {
    return fail('CONFLICT', '本次会话已保存基线，原始作答不可覆盖');
  }
  if (session.status !== 'TASK_PRESENTED') {
    return fail('PRECONDITION', '当前状态不能提交基线，请先查看任务');
  }

  const task = taskSpecOf(session.taskSpecJson);
  const createdAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const turnId = await appendUserTurn(
      tx,
      session.id,
      'BASELINE',
      input.text,
      input.clientRequestId,
    );
    await tx.aILearningSession.update({
      where: { id: session.id },
      data: { baselineText: input.text, status: 'BASELINE_SUBMITTED' },
    });
    const evidence = await tx.evidenceRecord.create({
      data: {
        skill: session.skill,
        evidenceType: 'BASELINE',
        level: 'QUICK',
        aiSessionId: session.id,
        conditionJson: JSON.stringify({
          prompt: task?.instructions ?? session.objective,
          materialSource: 'AI Learning Coach',
          timeLimitMinutes: task?.estimated_minutes ?? null,
          toolsAllowed: [],
          environment: 'AI Coach Session',
        }),
        outputText: input.text,
        assistanceLevel: 'A0',
        assessorType: 'SELF',
        confidence: 'MEDIUM',
        privacyLevel: 'PRIVATE',
        note: 'AI Learning Coach 基线：用户独立作答，AI 未修改',
        createdAt,
        updatedAt: createdAt,
      },
      select: { id: true },
    });
    await ensureRetestChain(tx, {
      id: evidence.id,
      skill: session.skill,
      evidenceType: 'BASELINE',
      chainRootId: null,
      createdAt,
    });
    return { turnId, evidenceId: evidence.id };
  });

  refreshAiPages(session.id);
  return ok(result);
}

export async function requestDiagnosisAction(
  raw: unknown,
): Promise<ActionResult<{ turnId: string; diagnosis: DiagnosisResult; text: string }>> {
  const parsed = requestTurnSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const { sessionId, clientRequestId } = parsed.data;

  const session = await prisma.aILearningSession.findUnique({ where: { id: sessionId } });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  if (!(session.baselineText ?? '').trim()) {
    return fail('PRECONDITION', '必须先保存独立基线，才能诊断');
  }
  if (session.status !== 'BASELINE_SUBMITTED') {
    return fail('PRECONDITION', '当前状态不能重新诊断');
  }

  await prisma.aILearningSession.update({
    where: { id: sessionId },
    data: { status: 'DIAGNOSING' },
  });
  const turn = await runAiTurn({
    prisma,
    sessionId,
    promptKind: 'diagnosis',
    turnKind: 'DIAGNOSIS',
    clientRequestId,
    meta: baseMeta(session),
  });

  if (!turn.ok) {
    await prisma.aILearningSession.update({
      where: { id: sessionId },
      data: { status: 'BASELINE_SUBMITTED', failureReason: turn.message.slice(0, 300) },
    });
    refreshAiPages(sessionId);
    return fail(
      turn.code === 'BUDGET_EXCEEDED' ? 'PRECONDITION' : 'INTERNAL',
      turn.message,
    );
  }

  await prisma.aILearningSession.update({
    where: { id: sessionId },
    data: { status: 'FEEDBACK_READY', failureReason: null },
  });
  refreshAiPages(sessionId);
  return ok({
    turnId: turn.turnId,
    diagnosis: turn.structured as DiagnosisResult,
    text: turn.text,
  });
}

export async function requestHintAction(
  raw: unknown,
): Promise<ActionResult<{ turnId: string; hint: HintResult; text: string }>> {
  const parsed = requestHintSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const { sessionId, clientRequestId, level } = parsed.data;

  const session = await prisma.aILearningSession.findUnique({ where: { id: sessionId } });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  if (
    !canRequestSupport({
      status: session.status as AiSessionStatus,
      baselineText: session.baselineText,
      directTeaching: session.directTeaching,
    })
  ) {
    return fail('PRECONDITION', '需要先完成基线并取得反馈，才能请求提示');
  }

  const maxUsed = await maxHintLevelUsed(sessionId);
  const check = validateHintRequest(maxUsed, level);
  if (!check.ok) return fail('PRECONDITION', check.message);

  const turn = await runAiTurn({
    prisma,
    sessionId,
    promptKind: 'hint',
    turnKind: 'HINT',
    clientRequestId,
    meta: baseMeta(session, {
      hintLevel: level,
      diagnosisSummary: await latestDiagnosisSummary(sessionId),
    }),
  });
  if (!turn.ok) {
    refreshAiPages(sessionId);
    return fail(turn.code === 'BUDGET_EXCEEDED' ? 'PRECONDITION' : 'INTERNAL', turn.message);
  }

  const hint = turn.structured as HintResult;
  if (hintLeaksAnswer(hint)) {
    return fail('INTERNAL', '提示输出违反 1–2 级不泄露答案的约束，已拒绝保存');
  }

  await prisma.aILearningSession.update({
    where: { id: sessionId },
    data: { status: 'HINTING' },
  });
  refreshAiPages(sessionId);
  return ok({ turnId: turn.turnId, hint, text: turn.text });
}

export async function requestTeachingAction(
  raw: unknown,
): Promise<ActionResult<{ turnId: string; feedback: FeedbackResult; text: string }>> {
  const parsed = requestTurnSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const { sessionId, clientRequestId } = parsed.data;

  const session = await prisma.aILearningSession.findUnique({ where: { id: sessionId } });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  const status = session.status as 'FEEDBACK_READY' | 'HINTING' | 'PRACTICE' | string;
  if (!['FEEDBACK_READY', 'HINTING', 'PRACTICE'].includes(status)) {
    return fail('PRECONDITION', '需要先完成基线并取得反馈，才能请求讲解');
  }

  const turn = await runAiTurn({
    prisma,
    sessionId,
    promptKind: 'teaching',
    turnKind: 'TEACHING',
    clientRequestId,
    meta: baseMeta(session, {
      diagnosisSummary: await latestDiagnosisSummary(sessionId),
    }),
  });
  if (!turn.ok) {
    refreshAiPages(sessionId);
    return fail(turn.code === 'BUDGET_EXCEEDED' ? 'PRECONDITION' : 'INTERNAL', turn.message);
  }

  await prisma.aILearningSession.update({
    where: { id: sessionId },
    data: { status: 'TEACHING', directTeaching: true },
  });
  refreshAiPages(sessionId);
  return ok({
    turnId: turn.turnId,
    feedback: turn.structured as FeedbackResult,
    text: turn.text,
  });
}

export async function generateDrillAction(
  raw: unknown,
): Promise<ActionResult<{ turnId: string; drill: DrillSet; text: string }>> {
  const parsed = requestTurnSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const { sessionId, clientRequestId } = parsed.data;

  const session = await prisma.aILearningSession.findUnique({ where: { id: sessionId } });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  const diagnosis = await latestDiagnosisSummary(sessionId);
  if (!diagnosis) return fail('PRECONDITION', '请先完成诊断，再生成针对性练习');
  if (!['FEEDBACK_READY', 'HINTING', 'TEACHING', 'PRACTICE'].includes(session.status)) {
    return fail('PRECONDITION', '当前状态不能生成练习');
  }

  const turn = await runAiTurn({
    prisma,
    sessionId,
    promptKind: 'drill',
    turnKind: 'DRILL',
    clientRequestId,
    meta: baseMeta(session, { diagnosisSummary: diagnosis }),
  });
  if (!turn.ok) {
    refreshAiPages(sessionId);
    return fail(turn.code === 'BUDGET_EXCEEDED' ? 'PRECONDITION' : 'INTERNAL', turn.message);
  }

  const drill = turn.structured as DrillSet;
  await prisma.$transaction([
    prisma.aILearningSession.update({ where: { id: sessionId }, data: { status: 'PRACTICE' } }),
    prisma.learningTaskInstance.create({
      data: {
        sessionId,
        taskSpecJson: JSON.stringify(drill),
        source: 'AI_DRILL',
        estimatedMinutes: drill.estimated_minutes,
        difficulty: 'ADAPTIVE',
        status: 'ACTIVE',
      },
    }),
  ]);
  refreshAiPages(sessionId);
  return ok({ turnId: turn.turnId, drill, text: turn.text });
}

export async function submitImmediateRetestAction(
  raw: unknown,
): Promise<
  ActionResult<{
    turnId: string;
    assessment: EvidenceAssessment;
    evidenceId: string;
    score: number;
  }>
> {
  const parsed = submitRetestSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const duplicate = await prisma.aILearningTurn.findUnique({
    where: {
      sessionId_clientRequestId: {
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
      },
    },
    select: { id: true },
  });
  if (duplicate) {
    const evidence = await prisma.evidenceRecord.findFirst({
      where: { aiSessionId: input.sessionId, evidenceType: 'IMMEDIATE_RETEST' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, score: true },
    });
    const assessmentTurn = await prisma.aILearningTurn.findFirst({
      where: { sessionId: input.sessionId, kind: 'ASSESSMENT' },
      orderBy: { sequence: 'desc' },
      select: { structuredJson: true },
    });
    const assessment = parseJson<EvidenceAssessment>(assessmentTurn?.structuredJson);
    if (!assessment) return fail('CONFLICT', '该复测已提交，但评估结果读取失败');
    return ok({
      turnId: duplicate.id,
      assessment,
      evidenceId: evidence?.id ?? '',
      score: evidence?.score ?? 0,
    });
  }

  const session = await prisma.aILearningSession.findUnique({ where: { id: input.sessionId } });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  if (!(session.baselineText ?? '').trim()) {
    return fail('PRECONDITION', '没有基线，不能进行复测');
  }
  if (
    !canStartRetest(
      session.status as Parameters<typeof canStartRetest>[0],
    )
  ) {
    return fail('PRECONDITION', '当前状态不能提交即时复测');
  }

  const task = taskSpecOf(session.taskSpecJson);
  const aidLevel = input.aidLevel ?? 'none';
  await prisma.$transaction(async (tx) => {
    await appendUserTurn(tx, session.id, 'RETEST', input.text, input.clientRequestId);
    await tx.aILearningSession.update({
      where: { id: session.id },
      data: { status: 'IMMEDIATE_RETEST' },
    });
  });

  const turn = await runAiTurn({
    prisma,
    sessionId: session.id,
    promptKind: 'assessment',
    turnKind: 'ASSESSMENT',
    clientRequestId: `assess-${input.clientRequestId}`,
    aidLevel,
    meta: baseMeta(session, {
      performanceType: 'immediate_retest',
      aidLevel,
      retestQuestion: task?.instructions ?? session.objective,
      retestAnswer: input.text,
    }),
  });

  if (!turn.ok) {
    await prisma.aILearningSession.update({
      where: { id: session.id },
      data: { status: 'PRACTICE', failureReason: turn.message.slice(0, 300) },
    });
    refreshAiPages(session.id);
    return fail(turn.code === 'BUDGET_EXCEEDED' ? 'PRECONDITION' : 'INTERNAL', turn.message);
  }

  const assessment = turn.structured as EvidenceAssessment;
  const assistanceLevel = toAssistanceLevel(aidLevel);
  const avg =
    assessment.rubric_scores.reduce((sum, item) => sum + item.score, 0) /
    Math.max(1, assessment.rubric_scores.length);
  const score = Math.max(
    0,
    Math.min(maxEvidenceScore(assistanceLevel), Math.round(avg)),
  );

  const baselineEvidence = await prisma.evidenceRecord.findFirst({
    where: { aiSessionId: session.id, evidenceType: 'BASELINE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, chainRootId: true },
  });
  const chainRootId = baselineEvidence
    ? baselineEvidence.chainRootId ?? baselineEvidence.id
    : null;
  const createdAt = new Date();

  const evidenceId = await prisma.$transaction(async (tx) => {
    const evidence = await tx.evidenceRecord.create({
      data: {
        skill: session.skill,
        evidenceType: 'IMMEDIATE_RETEST',
        level: 'QUICK',
        parentEvidenceId: baselineEvidence?.id ?? null,
        chainRootId,
        aiSessionId: session.id,
        conditionJson: JSON.stringify({
          prompt: task?.instructions ?? session.objective,
          materialSource: 'AI Learning Coach 即时复测',
          timeLimitMinutes: task?.estimated_minutes ?? null,
          toolsAllowed: aidLevel === 'none' ? [] : [aidLevel],
          environment: 'AI Coach Session',
          assessmentTurnId: turn.turnId,
        }),
        outputText: input.text,
        score,
        scoreReason: `AI 辅助评估（回合 ${turn.turnId}）`,
        assistanceLevel,
        assessorType: 'AI',
        confidence: assessment.confidence,
        privacyLevel: 'PRIVATE',
        note: `${AI_ASSESSMENT_DISCLAIMER_ZH} 表现类型：immediate_retest`,
        createdAt,
        updatedAt: createdAt,
      },
      select: { id: true },
    });
    await ensureRetestChain(tx, {
      id: evidence.id,
      skill: session.skill,
      evidenceType: 'IMMEDIATE_RETEST',
      chainRootId,
      createdAt,
    });
    // 基线排期中的「即时复测」已由本次 AI 复测完成，避免复测页出现重复待办。
    if (chainRootId) {
      const pendingImmediate = await tx.retestSchedule.findFirst({
        where: {
          parentEvidenceId: chainRootId,
          retestType: 'IMMEDIATE',
          status: 'PENDING',
        },
        orderBy: { dueDate: 'asc' },
        select: { id: true },
      });
      if (pendingImmediate) {
        await tx.retestSchedule.update({
          where: { id: pendingImmediate.id },
          data: { status: 'DONE', completedEvidenceId: evidence.id, completedAt: createdAt },
        });
      }
    }
    await tx.aILearningSession.update({
      where: { id: session.id },
      data: { status: 'COMPLETED', completedAt: createdAt, failureReason: null },
    });
    return evidence.id;
  });

  refreshAiPages(session.id);
  return ok({ turnId: turn.turnId, assessment, evidenceId, score });
}

export async function scheduleDelayedRetestAction(
  raw: unknown,
): Promise<ActionResult<{ scheduled: number; rootEvidenceId: string }>> {
  const parsed = sessionIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const { sessionId } = parsed.data;

  const session = await prisma.aILearningSession.findUnique({ where: { id: sessionId } });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  if (!canScheduleDelayedRetest(session.status as Parameters<typeof canScheduleDelayedRetest>[0])) {
    return fail('PRECONDITION', '完成即时复测后才能安排延迟复测');
  }

  const evidence = await prisma.evidenceRecord.findFirst({
    where: { aiSessionId: sessionId },
    orderBy: { createdAt: 'desc' },
  });
  if (!evidence) return fail('PRECONDITION', '本会话还没有可用证据，无法排复测');

  const rootId = evidence.chainRootId ?? evidence.id;
  const createdAt = evidence.createdAt;

  if (evidence.evidenceType === 'BASELINE') {
    await prisma.$transaction(async (tx) => {
      await ensureRetestChain(tx, {
        id: evidence.id,
        skill: evidence.skill,
        evidenceType: evidence.evidenceType,
        chainRootId: evidence.chainRootId,
        createdAt,
      });
      await tx.aILearningSession.update({
        where: { id: sessionId },
        data: { status: 'DELAYED_RETEST_SCHEDULED' },
      });
    });
  } else {
    await prisma.aILearningSession.update({
      where: { id: sessionId },
      data: { status: 'DELAYED_RETEST_SCHEDULED' },
    });
  }

  const scheduled = await prisma.retestSchedule.count({
    where: { parentEvidenceId: rootId, status: 'PENDING' },
  });
  if (scheduled === 0) {
    return fail('PRECONDITION', '未找到待执行的复测排期，请先在复测页检查证据链');
  }

  refreshAiPages(sessionId);
  return ok({ scheduled, rootEvidenceId: rootId });
}

export async function pauseAiSessionAction(
  raw: unknown,
): Promise<ActionResult<{ status: string }>> {
  const parsed = sessionIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const session = await prisma.aILearningSession.findUnique({
    where: { id: parsed.data.sessionId },
    select: { status: true },
  });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  if (isTerminal(session.status as Parameters<typeof isTerminal>[0])) {
    return fail('PRECONDITION', '已结束的会话不能暂停');
  }
  await prisma.aILearningSession.update({
    where: { id: parsed.data.sessionId },
    data: { status: 'PAUSED', pausedAt: new Date() },
  });
  refreshAiPages(parsed.data.sessionId);
  return ok({ status: 'PAUSED' });
}

export async function resumeAiSessionAction(
  raw: unknown,
): Promise<ActionResult<{ status: string }>> {
  const parsed = sessionIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const session = await prisma.aILearningSession.findUnique({
    where: { id: parsed.data.sessionId },
    include: { turns: { select: { kind: true } } },
  });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  if (session.status !== 'PAUSED') return fail('PRECONDITION', '只有暂停中的会话可以继续');

  const hasBaseline = (session.baselineText ?? '').trim().length > 0;
  const hasDiagnosis = session.turns.some((turn) => turn.kind === 'DIAGNOSIS');
  const status = hasBaseline
    ? hasDiagnosis
      ? 'FEEDBACK_READY'
      : 'BASELINE_SUBMITTED'
    : 'TASK_PRESENTED';
  await prisma.aILearningSession.update({
    where: { id: session.id },
    data: { status, pausedAt: null },
  });
  refreshAiPages(session.id);
  return ok({ status });
}

export async function cancelAiSessionAction(
  raw: unknown,
): Promise<ActionResult<{ status: string }>> {
  const parsed = sessionIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const session = await prisma.aILearningSession.findUnique({
    where: { id: parsed.data.sessionId },
    select: { status: true },
  });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  if (isTerminal(session.status as Parameters<typeof isTerminal>[0])) {
    return fail('PRECONDITION', '会话已结束');
  }
  await prisma.aILearningSession.update({
    where: { id: parsed.data.sessionId },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  refreshAiPages(parsed.data.sessionId);
  return ok({ status: 'CANCELLED' });
}

/** 删除会话：只删 AI 会话与轮次；证据保留，aiSessionId 自动置空。 */
export async function deleteAiSessionAction(
  raw: unknown,
): Promise<ActionResult<{ deleted: true }>> {
  const parsed = sessionIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const session = await prisma.aILearningSession.findUnique({
    where: { id: parsed.data.sessionId },
    select: { id: true },
  });
  if (!session) return fail('NOT_FOUND', '会话不存在');
  await prisma.aILearningSession.delete({ where: { id: session.id } });
  refreshAiPages();
  return ok({ deleted: true });
}

export async function markTurnFeedbackAction(
  raw: unknown,
): Promise<ActionResult<{ feedbackId: string }>> {
  const parsed = markTurnFeedbackSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const turn = await prisma.aILearningTurn.findUnique({
    where: { id: input.turnId },
    select: { sessionId: true },
  });
  if (!turn || turn.sessionId !== input.sessionId) {
    return fail('NOT_FOUND', '轮次不存在或不属于该会话');
  }
  const created = await prisma.aISessionFeedback.create({
    data: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      helpfulness: input.helpfulness,
      note: input.note?.trim() || null,
    },
    select: { id: true },
  });
  refreshAiPages(input.sessionId);
  return ok({ feedbackId: created.id });
}

/**
 * 把诊断转为错题候选：必须由用户点击确认并填写题目/答案；
 * 复用既有错题录入与复习调度，不新建第二套。
 */
export async function promoteDiagnosisToMistakeAction(
  raw: unknown,
): Promise<ActionResult<{ mistakeId: string; firstReviewDate: string }>> {
  const parsed = promoteDiagnosisSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const session = await prisma.aILearningSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true, skill: true },
  });
  if (!session) return fail('NOT_FOUND', '会话不存在');

  const diagnosisTurn = await prisma.aILearningTurn.findFirst({
    where: { sessionId: input.sessionId, kind: 'DIAGNOSIS' },
    orderBy: { sequence: 'desc' },
    select: { structuredJson: true },
  });
  const diagnosis = parseJson<DiagnosisResult>(diagnosisTurn?.structuredJson);
  if (!diagnosis) return fail('PRECONDITION', '还没有可转为错题的诊断');

  const stage = await prisma.stage.findFirst({ where: { status: 'ACTIVE' } });
  if (!stage) return fail('PRECONDITION', '没有进行中的阶段，请先激活阶段');

  const primaryCategory = diagnosis.error_categories[0] ?? 'KNOWLEDGE_GAP';
  const categoryMap: Record<string, string> = {
    KNOWLEDGE_GAP: 'RULE_NOT_UNDERSTOOD',
    RETRIEVAL_FAILURE: 'MEMORY_CONFUSION',
    ATTENTION: 'CARELESS',
    TASK_MISUNDERSTANDING: 'OTHER',
    STRATEGY: 'OTHER',
    TECHNICAL: 'OTHER',
  };
  const ieltsMap: Record<string, string> = {
    KNOWLEDGE_GAP: 'COMPREHENSION',
    RETRIEVAL_FAILURE: 'COMPREHENSION',
    ATTENTION: 'ATTENTION',
    TASK_MISUNDERSTANDING: 'STRATEGY',
    STRATEGY: 'STRATEGY',
    TECHNICAL: '',
  };

  return createMistakeAction({
    stageId: stage.id,
    sourceType: 'MANUAL',
    originalQuestion: input.originalQuestion,
    myAnswer: input.myAnswer,
    correctAnswer: input.correctAnswer,
    errorReason: input.errorReason,
    knowledgePoint: input.knowledgePoint,
    errorCategory: categoryMap[primaryCategory] ?? 'OTHER',
    ieltsErrorCategory: ieltsMap[primaryCategory] ?? '',
  });
}

export async function updateAiEngineSettingsAction(
  raw: unknown,
): Promise<ActionResult<{ updated: true }>> {
  const parsed = updateAiEngineSettingsSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  await prisma.aIEngineSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...parsed.data },
    update: parsed.data,
  });
  revalidatePath('/ai-coach/admin');
  refreshAiPages();
  return ok({ updated: true });
}

/**
 * 保存 Provider 凭据（Base URL、模型名、API Key）。
 *
 * - `apiKey` 留空表示保持原值；`clearApiKey=true` 表示清除；
 * - Key 以 AES-256-GCM 加密后入库，只保留末四位用于页面回显；
 * - 返回值永远不含明文或密文。
 */
export async function saveProviderCredentialAction(
  raw: unknown,
): Promise<ActionResult<{ apiKeyConfigured: boolean; apiKeyLast4: string | null }>> {
  const parsed = saveProviderCredentialSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const existing = await prisma.aIProviderCredential.findUnique({ where: { id: 'default' } });
  const next = {
    baseUrl: input.baseUrl,
    modelName: input.modelName,
    apiKeyCipher: existing?.apiKeyCipher ?? null,
    apiKeyLast4: existing?.apiKeyLast4 ?? null,
    keyUpdatedAt: existing?.keyUpdatedAt ?? null,
  };

  if (input.clearApiKey) {
    next.apiKeyCipher = null;
    next.apiKeyLast4 = null;
    next.keyUpdatedAt = null;
  } else if (input.apiKey) {
    next.apiKeyCipher = encryptSecret(input.apiKey);
    next.apiKeyLast4 = input.apiKey.slice(-4);
    next.keyUpdatedAt = new Date();
  }

  await prisma.aIProviderCredential.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...next },
    update: next,
  });

  revalidatePath('/ai-coach/admin');
  revalidatePath('/ai-coach');
  return ok({ apiKeyConfigured: Boolean(next.apiKeyCipher), apiKeyLast4: next.apiKeyLast4 });
}

export async function updateAiModelConfigAction(
  raw: unknown,
): Promise<ActionResult<{ updated: true }>> {
  const parsed = updateAiModelConfigSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;
  const existing = await prisma.aIModelConfig.findUnique({ where: { id: input.id } });
  if (!existing) return fail('NOT_FOUND', '模型配置不存在');
  if (!input.active && input.isDefault) {
    return fail('PRECONDITION', '停用的模型不能被设为默认');
  }

  await prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.aIModelConfig.updateMany({
        where: { id: { not: input.id } },
        data: { isDefault: false },
      });
    }
    await tx.aIModelConfig.update({
      where: { id: input.id },
      data: {
        label: input.label,
        inputPricePerMtok: input.inputPricePerMtok,
        outputPricePerMtok: input.outputPricePerMtok,
        active: input.active,
        isDefault: input.isDefault,
      },
    });
  });
  revalidatePath('/ai-coach/admin');
  return ok({ updated: true });
}

export async function initPromptRegistryAction(): Promise<
  ActionResult<{ prompts: number }>
> {
  const registry = await ensurePromptRegistry(prisma);
  revalidatePath('/ai-coach/admin');
  return ok({ prompts: Object.keys(registry).length });
}

/** 导出单个会话（JSON 字符串）；不包含任何密钥。 */
export async function exportAiSessionAction(
  raw: unknown,
): Promise<ActionResult<{ filename: string; json: string }>> {
  const parsed = sessionIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const session = await prisma.aILearningSession.findUnique({
    where: { id: parsed.data.sessionId },
    include: {
      turns: { orderBy: { sequence: 'asc' } },
      tasks: true,
      feedback: true,
      callLogs: { orderBy: { createdAt: 'desc' }, take: 20 },
      evidence: { select: { id: true, evidenceType: true, score: true, createdAt: true } },
    },
  });
  if (!session) return fail('NOT_FOUND', '会话不存在');

  const payload = {
    exportedAt: new Date().toISOString(),
    disclaimer: AI_ASSESSMENT_DISCLAIMER_ZH,
    session: {
      id: session.id,
      mode: session.mode,
      skill: session.skill,
      objective: session.objective,
      targetLevel: session.targetLevel,
      status: session.status,
      provider: session.provider,
      model: session.model,
      directTeaching: session.directTeaching,
      baselineText: session.baselineText,
      estimatedCostUsd: session.estimatedCostUsd,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    },
    turns: session.turns.map((turn) => ({
      sequence: turn.sequence,
      role: turn.role,
      kind: turn.kind,
      contentText: turn.contentText,
      structured: turn.structuredJson ? JSON.parse(turn.structuredJson) : null,
      createdAt: turn.createdAt,
    })),
    tasks: session.tasks.map((task) => ({
      source: task.source,
      estimatedMinutes: task.estimatedMinutes,
      status: task.status,
      taskSpec: JSON.parse(task.taskSpecJson),
    })),
    feedback: session.feedback,
    evidence: session.evidence,
    calls: session.callLogs.map((log) => ({
      provider: log.provider,
      model: log.model,
      status: log.status,
      latencyMs: log.latencyMs,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      estimatedCostUsd: log.estimatedCostUsd,
      createdAt: log.createdAt,
    })),
  };

  return ok({
    filename: `ai-session-${session.id}.json`,
    json: JSON.stringify(payload, null, 2),
  });
}