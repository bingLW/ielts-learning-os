/**
 * Session Orchestrator：一次 AI 回合的完整流程。
 *
 * v2.6 起拆成两层（ADR-06）：
 * - `runAiCompletion()`：**会话无关**的核心调用 —— 预算评估 → 取已发布提示词 →
 *   选择 Provider → 调用（超时最多重试 1 次）→ Schema 校验 → 写 `AICallLog` → 成本估算。
 *   教学回合（v2.4）与材料分析（v2.6）共用这一层，**不新建第二套 AI 调用层**。
 * - `runAiTurn()`：教学回合自己的两件事 —— ① 幂等 + 基线前置检查（先于核心调用）；
 *   ② 成功后的 `AILearningTurn` 创建 + 会话 Token 累计（一个事务）。
 *
 * 失败时不写 `AILearningTurn`，只写 `AICallLog`（append-only 遥测）；用户原始答案不受影响。
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
  type AiTurnFailureCode,
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

/**
 * 会话无关的核心调用入参（ADR-06）。
 *
 * `sessionId` 是 ADR-06 表格之外的**唯一追加字段**：`AICallLog.sessionId` 是既有列，
 * 教学回合的账本与预算拦截测试都按它过滤，抽出时必须原样带过去才能做到「逐行等价、
 * 行为不变」。材料域不传（它的归属走 `attribution`）。
 */
export interface RunAiCompletionInput {
  prisma: PrismaClient;
  promptKind: AiPromptKind;
  meta: AiPromptMeta;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** 材料域费用归属（`AICallLog.materialId` / `materialJobId`，ADR-06 Q5）。 */
  attribution?: { materialId?: string; materialJobId?: string };
  /** 教学回合归属；材料域不传。 */
  sessionId?: string;
}

/** 核心调用结果（字段与 ADR-06 表格一致）。 */
export type AiCompletionOutcome =
  | {
      ok: true;
      structured: unknown;
      text: string;
      status: AiCallStatus;
      logId: string;
      provider: string;
      model: string;
      promptVersionId: string;
      requestId: string;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      estimatedCostUsd: number;
    }
  | { ok: false; code: AiTurnFailureCode; message: string; logId?: string };

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
      // v2.6 材料域（material_extract / material_summary / material_exercise）：
      // 结果以结构化对象入库，不渲染为「教学回合文本」。
      return '';
  }
}

function failureStatus(code: string): AiCallStatus {
  if (code === 'TIMEOUT') return 'TIMEOUT';
  if (code === 'INVALID_OUTPUT') return 'INVALID_OUTPUT';
  return 'ERROR';
}

/**
 * 会话无关的 AI 核心调用（ADR-06）。
 *
 * 这段逻辑**从 `runAiTurn` 逐行搬出来**，没有改任何行为：预算闸门、`BLOCKED` 日志、
 * Provider 选择、TIMEOUT/NETWORK 重试（≤1）、Schema 校验、`AICallLog` 落账（含脱敏）、
 * 成本估算全部保持原样。唯一的结构性变化是 `AICallLog` **不再**写在回合事务里 ——
 * 它是 append-only 遥测，允许「有日志无 turn」（ADR-06 明确接受）。
 *
 * @param input 见 `RunAiCompletionInput`
 */
export async function runAiCompletion(
  input: RunAiCompletionInput,
): Promise<AiCompletionOutcome> {
  const { prisma, promptKind, meta } = input;
  const attribution = input.attribution;
  /** 三条日志路径共用的归属字段（教学=sessionId；材料=materialId/materialJobId）。 */
  const ownership = {
    sessionId: input.sessionId ?? null,
    materialId: attribution?.materialId ?? null,
    materialJobId: attribution?.materialJobId ?? null,
  };

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
    const blocked = await prisma.aICallLog.create({
      data: {
        ...ownership,
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
      select: { id: true },
    });
    return {
      ok: false,
      code: 'BUDGET_EXCEEDED',
      message: `已超出 AI 预算（今日 ${budget.dailyPercent}%，本月 ${budget.monthlyPercent}%），本次调用被拦截。`,
      logId: blocked.id,
    };
  }

  const provider = createProvider(config);
  const rendered = renderPrompt(promptKind, meta);
  const request = {
    kind: promptKind,
    system: rendered.system,
    user: rendered.user,
    temperature:
      input.temperature ?? (promptKind === 'assessment' ? 0.1 : 0.4),
    maxOutputTokens: input.maxOutputTokens ?? AI_MAX_OUTPUT_TOKENS,
    timeoutMs: input.timeoutMs ?? AI_DEFAULT_TIMEOUT_MS,
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
    const failed = await prisma.aICallLog.create({
      data: {
        ...ownership,
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
      select: { id: true },
    });
    return {
      ok: false,
      code: completion.code,
      message: `${completion.message}（已尝试 ${attempts} 次；你的作答已保存，可稍后重试）`,
      logId: failed.id,
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
    const invalid = await prisma.aICallLog.create({
      data: {
        ...ownership,
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
      select: { id: true },
    });
    return { ok: false, code: 'INVALID_OUTPUT', message: parsed.error, logId: invalid.id };
  }

  const status: AiCallStatus = isMock ? 'MOCK' : 'OK';
  const logged = await prisma.aICallLog.create({
    data: {
      ...ownership,
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
    select: { id: true },
  });

  return {
    ok: true,
    structured: parsed.data,
    text: renderAiText(promptKind, parsed.data),
    status,
    logId: logged.id,
    provider: provider.provider,
    model: provider.model,
    promptVersionId: promptVersion.versionId,
    requestId,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    latencyMs: completion.latencyMs,
    estimatedCostUsd: cost,
  };
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

  // ── 会话无关的核心调用（预算/提示词/Provider/重试/校验/记账） ──────────
  const outcome = await runAiCompletion({ prisma, sessionId, promptKind, meta });
  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }

  // ── 教学回合自己的落库：turn + 会话 Token/成本累计（一个事务） ──────────
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
        contentText: outcome.text,
        structuredJson: JSON.stringify(outcome.structured),
        aidLevel: input.promptKind === 'assessment' ? input.aidLevel ?? null : null,
        promptVersionId: outcome.promptVersionId,
        requestId: outcome.requestId,
        clientRequestId,
        latencyMs: outcome.latencyMs,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
      },
      select: { id: true },
    });
    await tx.aILearningSession.update({
      where: { id: sessionId },
      data: {
        inputTokens: { increment: outcome.inputTokens },
        outputTokens: { increment: outcome.outputTokens },
        totalLatencyMs: { increment: outcome.latencyMs },
        estimatedCostUsd: { increment: outcome.estimatedCostUsd },
      },
    });
    return turn.id;
  });

  return {
    ok: true,
    turnId,
    structured: outcome.structured,
    text: outcome.text,
    providerMode: outcome.status === 'MOCK' ? 'mock' : 'external',
    status: outcome.status,
    deduped: false,
  };
}
