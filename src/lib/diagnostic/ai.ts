/**
 * 诊断开放任务的 AI 评估入口。
 *
 * 统一复用 runAiCompletion 的外发同意、预算预占、脱敏与调用日志；
 * Mock 结果不会被当作诊断证据。
 */

import type { PrismaClient } from '@prisma/client';
import { loadEngineConfig } from '@/lib/ai/config';
import { runAiCompletion } from '@/lib/ai/orchestrator';
import { ensurePromptRegistry } from '@/lib/ai/registry';
import type { DiagnosticEvaluation } from '@/lib/ai/structured';
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
      callLogId: string;
      modelId: string;
      promptVersionId: string;
    }
  | {
      ok: false;
      code: 'AI_UNAVAILABLE' | 'PRECONDITION' | 'BUDGET_EXCEEDED' | 'TIMEOUT' | 'NETWORK' | 'INVALID_OUTPUT' | 'PROVIDER_ERROR';
      message: string;
    };

const EVAL_KINDS: DiagnosticEvaluatorKind[] = ['diag_speaking', 'diag_writing'];

export async function evaluateOpenResponse(input: EvaluateInput): Promise<EvaluateResult> {
  const { prisma, kind } = input;
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

  const outcome = await runAiCompletion({
    prisma,
    promptKind: kind as AiPromptKind,
    temperature: 0.1,
    logMetadata: { scope: 'diagnostic' },
    meta: {
      mode: 'EXAMINER',
      skill: kind === 'diag_speaking' ? 'SPEAKING' : 'WRITING',
      objective: input.itemPrompt.slice(0, 300),
      targetLevel: 'A2',
      itemPrompt: input.itemPrompt,
      rubricSummary: input.rubricSummary,
      learnerAnswer: input.learnerAnswer,
      learnerBackground: input.learnerBackground,
    },
  });
  if (!outcome.ok) {
    return { ok: false, code: outcome.code === 'BLOCKED' ? 'PROVIDER_ERROR' : outcome.code, message: outcome.message };
  }

  return {
    ok: true,
    data: outcome.structured as DiagnosticEvaluation,
    providerMode: 'external',
    latencyMs: outcome.latencyMs,
    callLogId: outcome.logId,
    modelId: outcome.model,
    promptVersionId: outcome.promptVersionId,
  };
}
