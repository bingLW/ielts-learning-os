/**
 * AI Engine 内部类型。
 *
 * 这些类型只在服务端使用；前端只消费结构化结果与渲染文本。
 */

import type {
  AiCoachMode,
  AiCoachSkill,
  AiTaskSkill,
  AiTurnKind,
} from '@/lib/constants';

/** 提示词种类，与 Prompt Registry 的 promptKey 一一对应。 */
export const AI_PROMPT_KINDS = [
  'task',
  'diagnosis',
  'hint',
  'teaching',
  'drill',
  'assessment',
  'reviewer',
] as const;
export type AiPromptKind = (typeof AI_PROMPT_KINDS)[number];

export const AI_PROMPT_KEY_BY_KIND: Record<AiPromptKind, string> = {
  task: 'ai.task.v1',
  diagnosis: 'ai.diagnosis.v1',
  hint: 'ai.hint.v1',
  teaching: 'ai.teaching.v1',
  drill: 'ai.drill.v1',
  assessment: 'ai.assessment.v1',
  reviewer: 'ai.reviewer.v1',
};

/** 调用日志状态；与 AICallLog.status 的取值一致。 */
export const AI_CALL_STATUSES = [
  'OK',
  'MOCK',
  'ERROR',
  'TIMEOUT',
  'INVALID_OUTPUT',
  'BLOCKED',
] as const;
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];

/**
 * 送进 Prompt 的最小变量集。
 *
 * 不包含完整历史；Context Builder 负责先裁剪再填进来。
 */
export interface AiPromptMeta {
  mode: AiCoachMode;
  skill: AiTaskSkill;
  objective: string;
  targetLevel: string;
  baseline?: string;
  taskInstructions?: string;
  diagnosisSummary?: string;
  hintLevel?: number;
  practiceQuestion?: string;
  retestQuestion?: string;
  retestAnswer?: string;
  performanceType?: string;
  aidLevel?: string;
  allowedAids?: string[];
  contextSummary?: string;
}

export interface AiCompletionRequest {
  kind: AiPromptKind;
  system: string;
  user: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  meta: AiPromptMeta;
}

export interface AiCompletionSuccess {
  ok: true;
  rawText: string;
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AiCompletionFailure {
  ok: false;
  code: 'TIMEOUT' | 'NETWORK' | 'PROVIDER_ERROR' | 'INVALID_OUTPUT';
  message: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  rawText?: string;
}

export type AiCompletionResult = AiCompletionSuccess | AiCompletionFailure;

export interface AiProvider {
  readonly mode: 'mock' | 'external';
  readonly provider: string;
  readonly model: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}

/** 会话上下文快照（写入 AILearningSession.contextJson）。 */
export interface AiContextSnapshot {
  track: string;
  ieltsTargetNote: string | null;
  skill: AiCoachSkill;
  profile: { cefrEstimate: string; confidence: string } | null;
  stage: { name: string; focus: string; acceptance: string | null } | null;
  recentErrors: Array<{ category: string; summary: string; occurredOn: string }>;
  recentEvidence: Array<{
    evidenceType: string;
    score: number | null;
    createdAt: string;
  }>;
  explainLanguage: string;
  directTeachingAllowed: boolean;
  remainingMinutes: number | null;
  limits: { maxErrors: number; maxEvidence: number };
}

/** 一次教学回合的持久化结果（不含 DB 写入细节）。 */
export interface AiTurnOutcome {
  turnId: string;
  structured: unknown;
  text: string;
  providerMode: 'mock' | 'external';
  status: AiCallStatus;
  deduped: boolean;
}

export type AiTurnFailureCode =
  | 'BLOCKED'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_OUTPUT'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PRECONDITION';

export type AiTurnResult =
  | ({ ok: true } & AiTurnOutcome)
  | { ok: false; code: AiTurnFailureCode; message: string };

export type AiTurnKindRef = AiTurnKind;