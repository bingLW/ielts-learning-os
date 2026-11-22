/**
 * Session Orchestrator：一次 AI 回合的完整流程。
 *
 * 顺序：幂等检查 → 预算检查 → 取已发布提示词 → 选择 Provider →
 * 调用（超时最多重试 1 次）→ Schema 校验 → 写轮次 + 调用日志 + 累计 Token/成本。
 *
 * 失败时不写 AILearningTurn，只写 AICallLog；用户原始答案不受影响。
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  AI_ASSESSMENT_DISCLAIMER_ZH,
  AI_DEFAULT_TIMEOUT_MS,
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_RETRIES,
} from '@/lib/constants';
import { createProvider, loadEngineConfig } from './config';
import {
  budgetConfigFrom,
  budgetWindows,
  estimateCostUsd,
  evaluateBudget,
} from './meter';
import { redactMetadata } from './privacy';
import { renderPrompt } from './prompts';
import { getPublishedPromptVersion } from './registry';
import {
  parseStructured,
  type StructuredByKind,
} from './structured';
import {
  AI_PROMPT_KEY_BY_KIND,
  type AiCallStatus,
  type AiPromptKind,
  type AiPromptMeta,
  type AiTurnKindRef,
  type AiTurnResult,
} from './types';

export interface RunAiTurnInput {
  prisma: PrismaClient;
  sessionId: string;
  promptKind: AiPromptKind;
  turnKind: AiTurnKindRef;
  meta: AiPromptMeta;
  clientRequestId: string;
  aidLevel?: string | null;
}

const BASELINE_REQUIRED: readonly AiPromptKind[] = [
  'diagnosis',
  'hint',
  'teaching',
  'drill',
  'assessment',
  'reviewer',
];

/** 把结构化结果渲染成用户可见文本；练习答案不进入文本，提交前不泄露。 */
export function renderAiText(kind: AiPromptKind, data: unknown): string {
  switch (kind) {
    case 'task': {
      const task = data as StructuredByKind['task'];
      const rubric = task.rubric.map((item) => `- ${item.criterion}`).join('\n');
      return [
        `【任务】${task.objective}`,
        task.instructions,
        `预计 ${task.estimated_minutes} 分钟；目标等级 ${task.target_level}。`,
        `评分点：\n${rubric}`,
      ].join('\n\n');
    }
    case 'diagnosis': {
      const result = data as StructuredByKind['diagnosis'];
      const evidence = result.observed_evidence
        .filter((item) => item.quote.trim().length > 0)
        .map((item) => `- 「${item.quote}」${item.location ? `（${item.location}）` : ''}`)
        .join('\n');
      return [
        `【诊断】${result.summary}`,
        evidence ? `证据：\n${evidence}` : '证据：证据不足，暂不做结论。',
        `优先处理：${result.priority_issues.join('；') || '见诊断摘要'}`,
        `下一步：${result.recommended_next_step}`,
      ].join('\n\n');
    }
    case 'hint': {
      const hint = data as StructuredByKind['hint'];
      const tail = hint.next_question ? `\n\n想一想：${hint.next_question}` : '';
      return `【第 ${hint.hint_level} 级提示】${hint.hint_text}${tail}`;
    }
    case 'teaching': {
      const feedback = data as StructuredByKind['teaching'];
      const corrections = feedback.specific_corrections
        .map((item) => `- 原句：${item.original}\n  修改：${item.corrected}\n  原因：${item.reason}`)
        .join('\n');
      return [
        `【讲解】${feedback.explanation}`,
        corrections ? `具体修改：\n${corrections}` : '',
        feedback.practice_recommendations.length > 0
          ? `建议练习：${feedback.practice_recommendations.join('；')}`
          : '',
        `限制：${feedback.limitations}`,
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    case 'drill': {
      const drill = data as StructuredByKind['drill'];
      const prompts = drill.items.map((item, index) => `${index + 1}. ${item.prompt}`).join('\n');
      return [
        `【练习】${drill.title}`,
        prompts,
        `完成后提交作答，再查看答案与解释。预计 ${drill.estimated_minutes} 分钟。`,
      ].join('\n\n');
    }
    case 'assessment': {
      const assessment = data as StructuredByKind['assessment'];
      const scores = assessment.rubric_scores
        .map((item) => `- ${item.criterion}：${item.score}/2${item.comment ? `（${item.comment}）` : ''}`)
        .join('\n');
      return [
        '【AI 辅助评估】',
        scores,
        `置信度：${assessment.confidence}`,
        assessment.limitations || AI_ASSESSMENT_DISCLAIMER_ZH,
      ].join('\n\n');
    }
    case 'reviewer': {
      const review = data as StructuredByKind['reviewer'];
      return [
        `【复盘】${review.summary}`,
        `改善：${review.comparison.improved.join('；') || '暂无'}`,
        `仍弱：${review.comparison.still_weak.join('；') || '暂无'}`,
        `平行复测：${review.retest_task.instructions}`,
        `下一步：${review.next_step}`,
      ].join('\n\n');
    }
    default:
      return '';
  }
}

function failureStatus(code: string): AiCallStatus {
  if (code === 'TIMEOUT') return 'TIMEOUT';
  if (code === 'INVALID_OUTPUT') return 'INVALID_OUTPUT';
  return 'ERROR';
}

export async function runAiTurn(input: RunAiTurnInput): Promise<AiTurnResult> {
  const { prisma, sessionId, promptKind, meta, clientRequestId } = input;

  const existing = await prisma.aILearningTurn.findUnique({
    where: { sessionId_clientRequestId: { sessionId, clientRequestId } },
  });
  if (existing) {
    let structured: unknown = null;
    try {
      structured = existing.structuredJson ? JSON.parse(existing.structuredJson) : null;
    } catch {
      structured = null;
    }
    const owner = await prisma.aILearningSession.findUnique({
      where: { id: sessionId },
      select: { provider: true },
    });
    const mock = (owner?.provider ?? 'mock') === 'mock';
    return {
      ok: true,
      turnId: existing.id,
      structured,
      text: existing.contentText,
      providerMode: mock ? 'mock' : 'external',
      status: mock ? 'MOCK' : 'OK',
      deduped: true,
    };
  }

  const session = await prisma.aILearningSession.findUnique({ where: { id: sessionId } });
  if (!session) {
    return { ok: false, code: 'PRECONDITION', message: '会话不存在' };
  }
  if (BASELINE_REQUIRED.includes(promptKind) && !(session.baselineText ?? '').trim()) {
    return {
      ok: false,
      code: 'PRECONDITION',
      message: '必须先保存独立基线作答，才能诊断或获得提示',
    };
  }

  const config = await loadEngineConfig(prisma);
  const promptVersion = await getPublishedPromptVersion(prisma, promptKind);
  if (!promptVersion) {
    return {
      ok: false,
      code: 'PRECONDITION',
      message: `提示词 ${AI_PROMPT_KEY_BY_KIND[promptKind]} 尚未发布，请先初始化 Prompt Registry`,
    };
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
        sessionId,
        provider: config.modelConfig.provider,
        model: config.modelConfig.model,
        promptVersionId: promptVersion.versionId,
        requestId,
        latencyMs: 0,
        status: 'BLOCKED',
        errorCode: 'BUDGET_EXCEEDED',
        redactedMetadataJson: JSON.stringify(
          redactMetadata({ kind: promptKind, dailyPercent: budget.dailyPercent }),
        ),
      },
    });
    return {
      ok: false,
      code: 'BUDGET_EXCEEDED',
      message: `已超出 AI 预算（今日 ${budget.dailyPercent}%，本月 ${budget.monthlyPercent}%），本次调用被拦截。`,
    };
  }

  const provider = createProvider(config);
  const rendered = renderPrompt(promptKind, meta);
  const request = {
    kind: promptKind,
    system: rendered.system,
    user: rendered.user,
    temperature: promptKind === 'assessment' ? 0.1 : 0.4,
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
        sessionId,
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
          redactMetadata({
            kind: promptKind,
            attempts,
            message: completion.message,
            objective: meta.objective,
          }),
        ),
      },
    });
    return {
      ok: false,
      code: completion.code,
      message: `${completion.message}（已尝试 ${attempts} 次；你的作答已保存，可稍后重试）`,
    };
  }

  const parsed = parseStructured(promptKind, completion.json);
  const isMock = provider.mode === 'mock';
  const cost = isMock
    ? 0
    : estimateCostUsd(completion.inputTokens, completion.outputTokens, {
        inputPricePerMtok: config.modelConfig.inputPricePerMtok,
        outputPricePerMtok: config.modelConfig.outputPricePerMtok,
      });

  if (!parsed.ok) {
    await prisma.aICallLog.create({
      data: {
        sessionId,
        provider: provider.provider,
        model: provider.model,
        promptVersionId: promptVersion.versionId,
        requestId,
        latencyMs: completion.latencyMs,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        estimatedCostUsd: cost,
        status: 'INVALID_OUTPUT',
        errorCode: 'SCHEMA_VALIDATION',
        redactedMetadataJson: JSON.stringify(
          redactMetadata({ kind: promptKind, error: parsed.error }),
        ),
      },
    });
    return { ok: false, code: 'INVALID_OUTPUT', message: parsed.error };
  }

  const text = renderAiText(promptKind, parsed.data);
  const status: AiCallStatus = isMock ? 'MOCK' : 'OK';

  const turnId = await prisma.$transaction(async (tx) => {
    const maxSequence = await tx.aILearningTurn.aggregate({
      where: { sessionId },
      _max: { sequence: true },
    });
    const turn = await tx.aILearningTurn.create({
      data: {
        sessionId,
        sequence: (maxSequence._max.sequence ?? 0) + 1,
        role: 'AI',
        kind: input.turnKind,
        contentText: text,
        structuredJson: JSON.stringify(parsed.data),
        aidLevel: input.promptKind === 'assessment' ? input.aidLevel ?? null : null,
        promptVersionId: promptVersion.versionId,
        requestId,
        clientRequestId,
        latencyMs: completion.latencyMs,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      },
      select: { id: true },
    });
    await tx.aICallLog.create({
      data: {
        sessionId,
        provider: provider.provider,
        model: provider.model,
        promptVersionId: promptVersion.versionId,
        requestId,
        latencyMs: completion.latencyMs,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        estimatedCostUsd: cost,
        status,
        errorCode: null,
        redactedMetadataJson: JSON.stringify(
          redactMetadata({
            kind: promptKind,
            mode: meta.mode,
            skill: meta.skill,
            attempts,
          }),
        ),
      },
    });
    await tx.aILearningSession.update({
      where: { id: sessionId },
      data: {
        inputTokens: { increment: completion.inputTokens },
        outputTokens: { increment: completion.outputTokens },
        totalLatencyMs: { increment: completion.latencyMs },
        estimatedCostUsd: { increment: cost },
      },
    });
    return turn.id;
  });

  return {
    ok: true,
    turnId,
    structured: parsed.data,
    text,
    providerMode: provider.mode,
    status,
    deduped: false,
  };
}