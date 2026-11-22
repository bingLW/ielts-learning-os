/**
 * AI Learning Coach 只读查询（页面用）。
 *
 * 所有派生统计都由数据库真实数据计算；没有数据就返回空数组/0，
 * 不填充静态假数据。
 */

import { AI_ENGINE_DEFAULTS, AI_HINT_MAX_LEVEL } from '@/lib/constants';
import { loadEngineConfig, readProviderEnv } from '@/lib/ai/config';
import { budgetConfigFrom, budgetWindows, evaluateBudget } from '@/lib/ai/meter';
import { lastNDays, toBusinessDate, today } from '@/lib/date';
import { prisma } from '@/lib/prisma';

function safeJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function listAiSessions(limit = 20) {
  return prisma.aILearningSession.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      _count: { select: { turns: true, evidence: true } },
    },
  });
}

export async function getAiSessionDetail(sessionId: string) {
  const session = await prisma.aILearningSession.findUnique({
    where: { id: sessionId },
    include: {
      turns: {
        orderBy: { sequence: 'asc' },
        include: { feedback: { select: { helpfulness: true, note: true } } },
      },
      tasks: { orderBy: { createdAt: 'asc' } },
      evidence: { orderBy: { createdAt: 'asc' } },
      callLogs: { orderBy: { createdAt: 'desc' }, take: 10 },
      feedback: true,
    },
  });
  if (!session) return null;

  let maxHintLevel = 0;
  const hints: Array<{ turnId: string; level: number; text: string }> = [];
  for (const turn of session.turns) {
    if (turn.kind !== 'HINT') continue;
    const hint = safeJson<{ hint_level: number; hint_text: string }>(turn.structuredJson);
    if (!hint) continue;
    maxHintLevel = Math.max(maxHintLevel, hint.hint_level);
    hints.push({ turnId: turn.id, level: hint.hint_level, text: hint.hint_text });
  }

  const baselineEvidenceId =
    session.evidence.find((item) => item.evidenceType === 'BASELINE')?.id ?? null;
  const pendingRetests = baselineEvidenceId
    ? await prisma.retestSchedule.count({
        where: {
          parentEvidenceId:
            session.evidence.find((item) => item.evidenceType === 'BASELINE')?.chainRootId ??
            baselineEvidenceId,
          status: 'PENDING',
        },
      })
    : 0;

  const hiddenDrill = (structured: unknown): unknown => {
    if (session.status === 'COMPLETED' || session.status === 'DELAYED_RETEST_SCHEDULED') {
      return structured;
    }
    const drill = structured as
      | { items?: Array<Record<string, unknown>> }
      | null
      | undefined;
    if (!drill || !Array.isArray(drill.items)) return structured;
    return {
      ...drill,
      items: drill.items.map(({ prompt, difficulty }) => ({ prompt, difficulty })),
    };
  };

  const { turns: _rawTurns, ...sessionSummary } = session;

  return {
    // 会话标量单独返回，不再携带原始 turns，避免调用方把未脱敏的结构化答案带到客户端。
    session: sessionSummary,
    turns: session.turns.map(({ structuredJson, feedback, ...rest }) => ({
      ...rest,
      structured:
        rest.kind === 'DRILL'
          ? hiddenDrill(safeJson<unknown>(structuredJson))
          : safeJson<unknown>(structuredJson),
      feedback,
    })),
    tasks: session.tasks.map((task) => ({
      ...task,
      taskSpec: safeJson<unknown>(task.taskSpecJson),
    })),
    evidence: session.evidence,
    callLogs: session.callLogs,
    hints,
    maxHintLevel: Math.min(AI_HINT_MAX_LEVEL, maxHintLevel),
    baselineEvidenceId,
    pendingRetests,
  };
}

export async function getAiCoachHomeData() {
  const [engine, sessions, setting] = await Promise.all([
    loadEngineConfig(prisma),
    listAiSessions(12),
    prisma.aIEngineSetting.findUnique({ where: { id: 'default' } }),
  ]);
  const env = readProviderEnv();
  return {
    engine,
    sessions,
    externalAiEnabled: engine.setting.externalAiEnabled,
    apiKeyPresent: Boolean(env.apiKey),
    baseUrl: env.baseUrl,
    explainLanguage: setting?.explainLanguage ?? 'ZH_MIXED',
    directTeachingDefault: setting?.directTeachingDefault ?? false,
  };
}

export async function getAiAdminData() {
  const [engine, setting, models, templates, promptVersions] = await Promise.all([
    loadEngineConfig(prisma),
    prisma.aIEngineSetting.findUnique({ where: { id: 'default' } }),
    prisma.aIModelConfig.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.promptTemplate.findMany({
      orderBy: { promptKey: 'asc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 3 } },
    }),
    prisma.promptVersion.count(),
  ]);
  const env = readProviderEnv();
  return {
    engine,
    setting:
      setting ??
      ({
        id: 'default',
        externalAiEnabled: false,
        dailyBudgetUsd: AI_ENGINE_DEFAULTS.dailyBudgetUsd,
        monthlyBudgetUsd: AI_ENGINE_DEFAULTS.monthlyBudgetUsd,
        warnPercent: AI_ENGINE_DEFAULTS.warnPercent,
        directTeachingDefault: false,
        explainLanguage: 'ZH_MIXED',
        updatedAt: new Date(0),
      } as const),
    models,
    templates,
    promptVersionCount: promptVersions,
    apiKeyPresent: Boolean(env.apiKey),
    baseUrl: env.baseUrl,
    modelOverride: env.modelOverride ?? null,
  };
}

export async function getAiUsageData(days = 14) {
  const [engine, logs, sessionCount] = await Promise.all([
    loadEngineConfig(prisma),
    prisma.aICallLog.findMany({
      where: { createdAt: { gte: new Date(Date.now() - days * 86_400_000) } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    prisma.aILearningSession.count(),
  ]);

  const { dayStart, monthStart } = budgetWindows(new Date());
  const [daily, monthly] = await Promise.all([
    prisma.aICallLog.aggregate({
      where: { createdAt: { gte: dayStart }, status: { in: ['OK', 'MOCK'] } },
      _sum: { estimatedCostUsd: true },
    }),
    prisma.aICallLog.aggregate({
      where: { createdAt: { gte: monthStart }, status: { in: ['OK', 'MOCK'] } },
      _sum: { estimatedCostUsd: true },
    }),
  ]);
  const budget = evaluateBudget(
    {
      dailyUsd: daily._sum.estimatedCostUsd ?? 0,
      monthlyUsd: monthly._sum.estimatedCostUsd ?? 0,
    },
    budgetConfigFrom(engine.setting),
  );

  const dates = lastNDays(days, today());
  const byDate = new Map(
    dates.map((date) => [
      date,
      { date, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, errors: 0 },
    ]),
  );
  const byStatus = new Map<string, number>();
  let totalTokens = 0;
  let totalCost = 0;
  let totalLatency = 0;

  for (const log of logs) {
    const key = toBusinessDate(log.createdAt);
    const bucket = byDate.get(key);
    if (bucket) {
      bucket.calls += 1;
      bucket.inputTokens += log.inputTokens;
      bucket.outputTokens += log.outputTokens;
      bucket.costUsd = Math.round((bucket.costUsd + log.estimatedCostUsd) * 1_000_000) / 1_000_000;
      if (!['OK', 'MOCK'].includes(log.status)) bucket.errors += 1;
    }
    byStatus.set(log.status, (byStatus.get(log.status) ?? 0) + 1);
    totalTokens += log.inputTokens + log.outputTokens;
    totalCost += log.estimatedCostUsd;
    totalLatency += log.latencyMs;
  }

  const calls = logs.length;
  const errorCalls =
    (byStatus.get('ERROR') ?? 0) +
    (byStatus.get('TIMEOUT') ?? 0) +
    (byStatus.get('INVALID_OUTPUT') ?? 0) +
    (byStatus.get('BLOCKED') ?? 0);

  return {
    engine,
    days,
    calls,
    sessionCount,
    totalTokens,
    totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
    avgLatencyMs: calls > 0 ? Math.round(totalLatency / calls) : 0,
    errorRate: calls > 0 ? Math.round((errorCalls / calls) * 1000) / 10 : 0,
    budget,
    dailySeries: [...byDate.values()],
    statusBreakdown: [...byStatus.entries()].map(([status, count]) => ({ status, count })),
    recentCalls: logs.slice(0, 20).map((log) => ({
      id: log.id,
      sessionId: log.sessionId,
      provider: log.provider,
      model: log.model,
      status: log.status,
      latencyMs: log.latencyMs,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      estimatedCostUsd: log.estimatedCostUsd,
      errorCode: log.errorCode,
      createdAt: log.createdAt,
    })),
  };
}

export async function listAiEvidenceRows(limit = 60) {
  return prisma.evidenceRecord.findMany({
    where: { aiSessionId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      aiSession: {
        select: { id: true, mode: true, objective: true, skill: true, status: true },
      },
    },
  });
}

export async function listAiReviewSessions() {
  return prisma.aILearningSession.findMany({
    where: { evidence: { some: {} } },
    orderBy: { updatedAt: 'desc' },
    take: 30,
    include: {
      evidence: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          evidenceType: true,
          score: true,
          assistanceLevel: true,
          assessorType: true,
          createdAt: true,
        },
      },
    },
  });
}