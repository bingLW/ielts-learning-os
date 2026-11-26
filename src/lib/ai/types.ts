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
  'diag_routing',
  'diag_speaking',
  'diag_writing',
  'diag_error',
  'diag_summary',
  'diag_plan',
  // v2.6 材料域（ADR-06：复用同一套 provider / 重试 / 记账，不新建第二套 AI 层）
  'material_extract',
  'material_summary',
  'material_exercise',
  // v2.7 规划域（T14：只润色措辞 / 从池中挑候选 / 建议周主题，不碰调度）
  'plan_explain',
  'plan_suggest_candidates',
  'plan_weekly_theme',
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
  diag_routing: 'ai.diag.routing.v1',
  diag_speaking: 'ai.diag.speaking.v1',
  diag_writing: 'ai.diag.writing.v1',
  diag_error: 'ai.diag.error.v1',
  diag_summary: 'ai.diag.summary.v1',
  diag_plan: 'ai.diag.plan.v1',
  material_extract: 'ai.material.extract.v1',
  material_summary: 'ai.material.summary.v1',
  material_exercise: 'ai.material.exercise.v1',
  plan_explain: 'ai.plan.explain.v1',
  plan_suggest_candidates: 'ai.plan.suggest.v1',
  plan_weekly_theme: 'ai.plan.weekly.v1',
};

/** 规划域 prompt kind（`src/lib/ai/planner.ts` 只允许这几个）。 */
export const PLAN_PROMPT_KINDS = [
  'plan_explain',
  'plan_suggest_candidates',
  'plan_weekly_theme',
] as const satisfies readonly AiPromptKind[];
export type PlanPromptKind = (typeof PLAN_PROMPT_KINDS)[number];

/** 材料域 prompt kind（T09 的 `src/lib/ai/material.ts` 只允许这几个）。 */
export const MATERIAL_PROMPT_KINDS = [
  'material_extract',
  'material_summary',
  'material_exercise',
] as const satisfies readonly AiPromptKind[];
export type MaterialPromptKind = (typeof MATERIAL_PROMPT_KINDS)[number];

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
  /**
   * `'PLAN'` 是 v2.7 规划域专用的非教学模式：它不创建会话、不写 `AILearningTurn`，
   * 只用来把「润色 / 挑选 / 周主题」三类请求送进同一套 provider 与日志。
   */
  mode: AiCoachMode | 'PLAN';
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
  /** v2.4.1 诊断专用：任务题干、评分规准、学习者原始作答与背景摘要。 */
  itemPrompt?: string;
  rubricSummary?: string;
  learnerAnswer?: string;
  learnerBackground?: string;
  profileSummary?: string;
  /**
   * v2.6 材料域专用变量。
   *
   * 注意：`materialChunksBlock` **只**允许放 `wrapMaterialData()` 的产物
   * （已带 nonce 分隔符与来源前缀），不得放裸 chunk 文本。
   */
  materialTitle?: string;
  materialChunksBlock?: string;
  materialSkillTarget?: string;
  exerciseTypes?: string;
  questionBudget?: number;
  allowedKinds?: string;
  learnerLevel?: string;
  /**
   * v2.7 规划域专用变量。
   *
   * `candidatePoolBlock` 只放候选摘要（key/来源/技能/分钟），**不放**任务正文；
   * 时间、预算、装箱结果由调度器决定，AI 无权修改（`41 §6.1`）。
   */
  planDayBlock?: string;
  candidatePoolBlock?: string;
  budgetMinutes?: number;
  dailyBudgetBlock?: string;
  weeklyMetricsBlock?: string;
  gapSummaryBlock?: string;
  recentDeltaBlock?: string;
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