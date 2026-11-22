/**
 * 诊断开放任务的 AI 评估入口。
 *
 * 复用 v2.4 AI Engine 的 Provider / Prompt Registry / 预算 / 日志；
 * 与教学回合不同：诊断评估不属于某个 AILearningSession，日志 sessionId 为 null。
 *
 * 重要：只有外部模型真实可用时才自动评分。Mock 结果只用于开发验证，
 * 不会被当作诊断证据；调用方会降级为「待评估/补测」。
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  AI_DEFAULT_TIMEOUT_MS,
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_RETRIES,
} from '@/lib/constants';
import { createProvider, loadEngineConfig } from '@/lib/ai/config';
import {
  budgetConfigFrom,
  budgetWindows,
  estimateCostUsd,
  evaluateBudget,
} from '@/lib/ai/meter';
import { redactMetadata } from '@/lib/ai/privacy';
import { renderPrompt } from '@/lib/ai/prompts';
import { ensurePromptRegistry, getPublishedPromptVersion } from '@/lib/ai/registry';
import { parseStructured, type DiagnosticEvaluation } from '@/lib/ai/structured';
import type { AiPromptKind } from '@/lib/ai/types';

export type DiagnosticEvaluatorKind = 'diag_speaking' | 'diag_writing';

export interface EvaluateInput {
  prisma: PrismaClient;
  kind: DiagnosticEvaluatorKind;
  itemPrompt: string;
  rubricSummary: string;
  learnerAnswer: string;
  learnerBackground?: string;
  externalAiConsent?: boolean;
}

export type EvaluateResult =
  | {
      ok: true;
      data: DiagnosticEvaluation;
      providerMode: 'external';
      latencyMs: number;
    }
  | {
      ok: false;
      code: 'AI_UNAVAILABLE' | 'BUDGET_EXCEEDED' | 'TIMEOUT' | 'NETWORK' | 'INVALID_OUTPUT' | 'PROVIDER_ERROR';
      message: string;
    };

const EVAL_KINDS: DiagnosticEvaluatorKind[] = ['diag_speaking', 'diag_writing'];

function failureStatus(code: string) {
  if (code === 'TIMEOUT') return 'TIMEOUT';
  if (code === 'INVALID_OUTPUT') return 'INVALID_OUTPUT';
  return 'ERROR';
}

export async function evaluateOpenResponse(input: EvaluateInput): Promise<EvaluateResult> {
  const { prisma, kind } = input;
  // 诊断作答属于第三方外发：未勾选同意时不得调用外部模型，保留待评估。
  if (input.externalAiConsent !== true) {
    return {
      ok: false,
      code: 'AI_UNAVAILABLE',
      message: '本轮未同意外部 AI 评估，开放任务保留为待评估。',
    };
  }
  await ensurePromptRegistry(prisma, EVAL_KINDS);

  const config = await loadEngineConfig(prisma);
  if (config.providerMode !== 'external') {
    return {
      ok: false,
      code: 'AI_UNAVAILABLE',
      message: '外部 AI 未启用，开放任务保留为待评估；不会用模拟结果定级。',
    };
  }

  const promptVersion = await getPublishedPromptVersion(prisma, kind as AiPromptKind);
  if (!promptVersion) {
    return { ok: false, code: 'AI_UNAVAILABLE', message: '评估提示词尚未发布，请先初始化 Prompt Registry。' };
  }

  const budgetConfig = budgetConfigFrom(config.setting);
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
    budgetConfig,
  );

  const requestId = randomUUID();
  if (budget.state === 'EXCEEDED') {
    await prisma.aICallLog.create({
      data: {
        sessionId: null,
        provider: config.modelConfig.provider,
        model: config.modelConfig.model,
        promptVersionId: promptVersion.versionId,
        requestId,
        latencyMs: 0,
        status: 'BLOCKED',
        errorCode: 'BUDGET_EXCEEDED',
        redactedMetadataJson: JSON.stringify(
          redactMetadata({ kind, dailyPercent: budget.dailyPercent, scope: 'diagnostic' }),
        ),
      },
    });
    return {
      ok: false,
      code: 'BUDGET_EXCEEDED',
      message: `已超出 AI 预算（今日 ${budget.dailyPercent}%），开放任务保留为待评估。`,
    };
  }

  const provider = createProvider(config);
  const meta = {
    mode: 'EXAMINER' as const,
    skill: kind === 'diag_speaking' ? ('SPEAKING' as const) : ('WRITING' as const),
    objective: input.itemPrompt.slice(0, 300),
    targetLevel: 'A2',
    itemPrompt: input.itemPrompt,
    rubricSummary: input.rubricSummary,
    learnerAnswer: input.learnerAnswer,
    learnerBackground: input.learnerBackground,
  };
  const rendered = renderPrompt(kind as AiPromptKind, meta);

  const request = {
    kind: kind as AiPromptKind,
    system: rendered.system,
    user: rendered.user,
    temperature: 0.1,
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    timeoutMs: AI_DEFAULT_TIMEOUT_MS,
    meta,
  };

  let completion = await provider.complete(request);
  let attempts = 1;
  while (
    !completion.ok &&
    (completion.code === 'TIMEOUT' || completion.code === 'NETWORK') &&
    attempts <= AI_MAX_RETRIES
  ) {
    attempts += 1;
    completion = await provider.complete(request);
  }

  if (!completion.ok) {
    await prisma.aICallLog.create({
      data: {
        sessionId: null,
        provider: provider.provider,
        model: provider.model,
        promptVersionId: promptVersion.versionId,
        requestId,
        latencyMs: completion.latencyMs,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        estimatedCostUsd: 0,
        status: failureStatus(completion.code),
        errorCode: completion.code,
        redactedMetadataJson: JSON.stringify(
          redactMetadata({ kind, attempts, scope: 'diagnostic' }),
        ),
      },
    });
    return { ok: false, code: completion.code, message: completion.message };
  }

  const parsed = parseStructured(kind as AiPromptKind, completion.json);
  const cost = estimateCostUsd(completion.inputTokens, completion.outputTokens, {
    inputPricePerMtok: config.modelConfig.inputPricePerMtok,
    outputPricePerMtok: config.modelConfig.outputPricePerMtok,
  });

  await prisma.aICallLog.create({
    data: {
      sessionId: null,
      provider: provider.provider,
      model: provider.model,
      promptVersionId: promptVersion.versionId,
      requestId,
      latencyMs: completion.latencyMs,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      estimatedCostUsd: cost,
      status: parsed.ok ? 'OK' : 'INVALID_OUTPUT',
      errorCode: parsed.ok ? null : 'SCHEMA_VALIDATION',
      redactedMetadataJson: JSON.stringify(
        redactMetadata({ kind, attempts, scope: 'diagnostic', error: parsed.ok ? undefined : parsed.error }),
      ),
    },
  });

  if (!parsed.ok) {
    return { ok: false, code: 'INVALID_OUTPUT', message: parsed.error };
  }

  return {
    ok: true,
    data: parsed.data as DiagnosticEvaluation,
    providerMode: 'external',
    latencyMs: completion.latencyMs,
  };
}