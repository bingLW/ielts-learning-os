/**
 * v2.7 T07 `buildPlan()` —— 编排快照 → 缺口 → 候选 → 优先级 → 自适应计划 → 组装草稿。
 *
 * 这条链路是「可解释性数据流」的收口点（`41 §4.2` 第 ⑥ 步）：
 *
 * ```
 * buildPlanningSnapshot()  →  generateAdaptivePlan()  →  组装 PlannedTaskDraft
 *   （唯一读库点，落快照）       （消费 decision 的 priority/rationale）  （explanation 直接引用 decision）
 * ```
 *
 * 铁律（`41 §4.1`）：解释面板上的每一个字都来自同一次调度调用的 `TaskPriorityDecision`。
 * 所以本文件**禁止**重算 `score` / `rationale` / `priority`：它们一律从
 * `context.decisions` 原样透传进 `RankedCandidateInput`，再由引擎写进 `AdaptivePlanItem.rationale`，
 * 最后装进 `explanation.reason`。
 *
 * `aiMode` 三态（`41 §2.6`）：`allowAi !== true` 或 provider 未配置 → `off`；
 * 配置可用时调 `ai/planner.ts` 的三个入口（**只润色措辞 / 从池中挑候选 / 周主题**），
 * 任一失败 → `failed` 并整条回落规则输出（AC-17），AI 输出不能改任何调度字段。
 *
 * 预览**零写库**：本函数只调用 `buildPlanningSnapshot`（落 `PlanningSnapshot`，那是复算依据），
 * **绝不**写 `PlanTask` / `PlanVersion`。确认动作在 `actions/planner.ts::confirmPlanVersionAction`
 * 里做，且复用同一个 `snapshotId`。
 *
 * AI 采纳时会更新快照内的 `TaskCandidate.isAiSuggested` / `TaskPriorityDecision.eligibility`，
 * 这是快照元数据而非计划行，仍满足「预览不写计划」。
 */

import { createHash } from 'node:crypto';
import {
  planAiAvailable,
  polishExplanations,
  suggestCandidateOrder,
  type TaskExplanationSeed,
} from '@/lib/ai/planner';
import { CANDIDATE_DEFAULT_MINUTES, PRIORITY_FACTOR_KEYS, tierCodeOf } from '@/lib/constants';
import { checkAllocation } from '@/lib/domain/allocation';
import {
  generateAdaptivePlan,
  type RankedCandidateInput,
  type SkillGapHint,
  type UncertaintyProbeInput,
} from '@/lib/domain/adaptivePlan';
import { mapCandidateSourceToPlanTask, type GapKindForMapping } from '@/lib/domain/planWriteMap';
import type { Prerequisite, TaskCandidateDraft } from '@/lib/domain/taskCandidate';
import { resolveAiPicks } from '@/lib/domain/taskCandidate';
import { assertReasonOnlyChanged, FACTOR_LABEL_ZH } from '@/lib/domain/taskPriority';
import { prisma } from '@/lib/prisma';
import {
  buildPlanningSnapshot,
  type PlanEngineContextV27,
} from '@/lib/services/planningSnapshot';
import { getPlannerSettings } from '@/lib/queries/budget';
import { fail, ok } from '@/lib/result';
import type {
  ActionResult,
  LearningTrack,
  ModuleId,
  PrimarySkill,
  SkillAllocation,
  SkillId,
  TaskPriority,
  TaskSourceKind,
} from '@/lib/types';

/** AI 参与三态（`41 §2.6`）。 */
export type AiMode = 'off' | 'on' | 'failed';

/**
 * 计划层级（`PlanVersion.layer` 的取值；`horizonDays` 唯一决定）。
 * `DAY` 在 `PlanVersion.layer` 里落 `null`，但内存里显式用 `'DAY'` 便于分支。
 */
export type PlanLayer = 'DAY' | 'WEEK' | 'MONTH' | 'CYCLE';

/** `horizonDays → PlanLayer`（`41 §2.6`：1 | 7 | 30 | 90）。 */
export function layerOf(horizonDays: number): PlanLayer {
  if (horizonDays === 1) return 'DAY';
  if (horizonDays === 7) return 'WEEK';
  if (horizonDays === 30) return 'MONTH';
  return 'CYCLE';
}

/** 计划输入的 schema 里 `horizonDays` 只允许这 4 个值。 */
export const HORIZON_DAYS = [1, 7, 30, 90] as const;

export interface BuildPlanInput {
  purpose: 'GENERATE' | 'REPLAN';
  asOfDate: string;
  /** 1（日）| 7 | 30 | 90 */
  horizonDays: number;
  stageId?: string;
  /** REPLAN 必填 */
  planDate?: string;
  /** 覆盖 asOfDate 当日预算（不传则用 `getEffectiveBudget` 结果）。 */
  budgetOverrideMinutes?: number;
  /** 是否允许调用 AI（T07 只实现 false 路径）。 */
  allowAi?: boolean;
  /** 草稿 ID：T07 复用 `PlanningSnapshot.id`；预览仍零写 PlanTask/PlanVersion。 */
  draftId?: string | null;
}

/** 三态徽章（`41 §4.3`）：T07 恒为 `RULE`。 */
export type ExplanationOrigin = 'RULE' | 'AI' | 'USER_EDIT';

/** 措辞来源（`41 §4.3`）：`mode !== 'on'` 恒为 `TEMPLATE`。 */
export type WordingSource = 'TEMPLATE' | 'AI_POLISHED';

/** 可解释性数据（`41 §4.3` 字段级来源）。 */
export interface TaskExplanation {
  /** 直接取 decision.rationale（引擎把 candidate.rationale 原样写进 item.rationale）。 */
  reason: string;
  /** 直接取 goal（快照）。 */
  goalRef: string | null;
  /** 直接取 decision.meta.skillGapKey + evidenceRefs。 */
  gapRef: { skillGapKey: string; evidenceRefs: string[] } | null;
  /** 直接取 candidate.estMinutes / minMinutes（不是被截断后的 item.minutes）。 */
  estMinutes: number;
  minMinutes: number;
  /** 直接取 decision.priority。 */
  priority: TaskPriority;
  /** 直接取 candidate.prerequisites + 同一次评分的结果（met 由 decision.eligibility 决定）。 */
  prerequisites: { text: string; met: boolean }[];
  /** 直接取 candidate.expectedOutput。 */
  expectedOutput: string | null;
  /** 直接取 decision.consequenceIfSkipped。 */
  consequenceIfSkipped: string | null;
  origin: ExplanationOrigin;
  wordingSource: WordingSource;
}

/** 一条计划草稿（预览态，未写库）。 */
export interface PlannedTaskDraft {
  candidateKey: string | null;
  module: ModuleId;
  skill: SkillId;
  primarySkill: PrimarySkill;
  track: LearningTrack;
  planDate: string;
  plannedMinutes: number;
  minChunkMinutes: number;
  splittable: boolean;
  priority: TaskPriority;
  sourceKind: TaskSourceKind;
  explanation: TaskExplanation;
  /** 仅 AI 层可置 true；赋值点唯一（`assembleDraft` 内，见 `41 §6.5`）。 */
  byAi: boolean;
  aiCallLogId: string | null;
}

/** 取舍区（`41 §2.6` / PRD §4.5③）：全部来自引擎的 `backlog` 与 `priorityMinutes`。 */
export interface PlanTradeoffs {
  excludedByBudget: { title: string; minutes: number; reason: string }[];
  /** 三项分母都是「已安排总分钟」，分子分别 P0 / (P1+P2) / P3，之和恒为 1（总分钟>0 时）。 */
  p0Ratio: number;
  coreRatio: number;
  extensiveRatio: number;
  uncertaintyDeferred: { skill: string; why: string }[];
  silentSkills: { skill: string; why: string }[];
}

/** 一个周的里程碑（MONTH 层 8 项结构里的第 2 项）。 */
export interface WeeklyMilestone {
  week: number;
  startDate: string;
  goal: string;
}

/**
 * MONTH / CYCLE 层的结构化产物（`41 §5.2` 8 项结构）。
 * 存进 `PlanVersion.afterSnapshot`，是 AC-4 唯一的可验收产物。
 */
export interface PlanLayerStructure {
  layer: 'MONTH' | 'CYCLE';
  /** 8 项之一：阶段目标。 */
  stageGoal: string;
  /** 8 项之一：周里程碑（MONTH=4 个）。 */
  weeklyMilestones: WeeklyMilestone[];
  /** 8 项之一：技能配比。 */
  skillAllocation: SkillAllocation;
  /** 8 项之一：每周测试。 */
  weeklyTests: string;
  /** 8 项之一：材料建议。 */
  materialSuggestions: string;
  /** 8 项之一：词汇语法范围。 */
  vocabGrammarScope: string;
  /** 8 项之一：验收指标。 */
  acceptanceCriteria: string;
  /** 8 项之一：调整条件。 */
  adjustmentConditions: string;
}

export interface BuildPlanResult {
  snapshotId: string;
  inputHash: string;
  ruleVersion: string;
  weightsVersion: string;
  aiMode: AiMode;
  aiNote: string | null;
  horizonDays: number;
  days: {
    date: string;
    budgetMinutes: number;
    isRestDay: boolean;
    tasks: PlannedTaskDraft[];
  }[];
  tradeoffs: PlanTradeoffs;
  rejectedAiSuggestions: { title: string; reason: string; aiCallLogId: string | null }[];
  warnings: string[];
  /** 预览态：buildPlan 永不写 PlanTask/PlanVersion。 */
  preview: true;
  /** MONTH/CYCLE 层的 8 项结构；DAY/WEEK 为 null。 */
  layerStructure: PlanLayerStructure | null;
  /** 派生层级（`horizonDays` 唯一决定）。 */
  layer: PlanLayer;
}

/**
 * 预览令牌（无状态）：`sha256(['plan', snapshotId, inputHash, budgetOverride ?? '']).slice(0, 24)`。
 * 确认时用同一个 `snapshotId` 反查 `inputHash` 重算，不等 → `CONFLICT`。
 *
 * `budgetOverrideMinutes` 必须进签名：它不进 `PlanningSnapshot.inputHash`（快照装配时
 * 没有这个入参），但会改变落库计划分钟 —— 不签它，preview 传 override=60、confirm 传 90
 * 会命中同一 token 却写出不同计划（「预览 == 实际」被打破）。
 */
export function previewTokenOf(snapshotId: string, inputHash: string, budgetOverrideMinutes?: number): string {
  return createHash('sha256')
    .update(['plan', snapshotId, inputHash, budgetOverrideMinutes ?? ''].join('|'), 'utf8')
    .digest('hex')
    .slice(0, 24);
}

/** 技能字符串 → 补测探针的模块/主技能（OFFICIAL 四项为主，辅助维度兜底）。 */
const SKILL_TO_PROBE_AXES: Record<string, { module: ModuleId; primarySkill: PrimarySkill }> = {
  LISTENING: { module: 'LISTENING', primarySkill: 'LISTENING' },
  READING: { module: 'READING', primarySkill: 'READING' },
  SPEAKING: { module: 'SPEAKING', primarySkill: 'SPEAKING' },
  WRITING: { module: 'WRITING', primarySkill: 'WRITING' },
  GRAMMAR: { module: 'GRAMMAR', primarySkill: 'FOUNDATION' },
  VOCABULARY: { module: 'VOCAB_REVIEW', primarySkill: 'FOUNDATION' },
  SENTENCE_STRUCTURE: { module: 'SENTENCE', primarySkill: 'FOUNDATION' },
};

function probeAxesOf(skill: string): { module: ModuleId; primarySkill: PrimarySkill } {
  return SKILL_TO_PROBE_AXES[skill] ?? { module: 'READING', primarySkill: 'FOUNDATION' };
}

/** 从 `priorityPolicy` JSON 里取 `bufferRatio`（缺失/损坏回落 0）。 */
function bufferRatioOf(raw: string | null | undefined): number {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    const value = parsed.bufferRatio;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.min(0.3, Math.max(0, value));
    }
  } catch {
    // 配置损坏：回落到 0（v2.1 行为）
  }
  return 0;
}

/** 缺口裁决反查表：`skillGapKey → GapKindForMapping`。 */
function gapKindByKey(
  gaps: readonly { dimensionKind: string; skill: string; subskill: string; kind: string }[],
): Map<string, GapKindForMapping> {
  const map = new Map<string, GapKindForMapping>();
  for (const gap of gaps) {
    const key = `${gap.dimensionKind}:${gap.skill}:${gap.subskill}`;
    if (gap.kind === 'GAP' || gap.kind === 'UNCERTAINTY' || gap.kind === 'UNKNOWN') {
      map.set(key, gap.kind);
    }
  }
  return map;
}

/** 前置条件的人话描述（`41 §4.3` 的 `prerequisites.text`）。 */
function prerequisiteText(item: Prerequisite): string {
  switch (item.kind) {
    case 'STAGE_AT_LEAST':
      return `阶段不低于 ${item.code}`;
    case 'MATERIAL_READY':
      return '材料已就绪';
    case 'EXERCISE_APPROVED':
      return '题目已通过审核';
    case 'TRANSCRIPT_CONFIRMED':
      return '转写已确认';
    case 'UNIT_ORDER':
      return '前置单元已完成';
    case 'EVIDENCE_EXISTS':
      return '证据存在';
    default:
      return '前置条件';
  }
}

interface CandidateDecisionPair {
  candidate: PlanEngineContextV27['candidates'][number];
  decision: PlanEngineContextV27['decisions'][number];
}

/** AI 层在一次预览内可施加的效果（`off`/`failed` 时为空集）。 */
interface AiApplication {
  mode: AiMode;
  note: string | null;
  /** 通过调度器复核的 AI 挑选（`byAi` 的唯一来源之一）。 */
  picks: ReadonlySet<string>;
  /** 通过校验的润色措辞（key → reason）。 */
  polished: ReadonlyMap<string, string>;
  suggestLogId: string | null;
  explainLogId: string | null;
}

/** 把引擎产出的一项计划映射回草稿（含解释面板所需的 candidate/decision 上下文）。 */
function assembleDraft(
  item: { module: ModuleId; skill: SkillId; minutes: number; track: LearningTrack; primarySkill: PrimarySkill; priority: TaskPriority; sourceKind: TaskSourceKind; splittable: boolean; minChunkMinutes: number; rationale: string },
  planDate: string,
  goal: PlanEngineContextV27['goal'],
  pair: CandidateDecisionPair | null,
  ai: AiApplication,
): PlannedTaskDraft {
  const decision = pair?.decision ?? null;
  const candidate = pair?.candidate ?? null;
  const met = decision ? decision.eligibility !== 'BLOCKED_PREREQUISITE' : true;
  const key = candidate?.candidateKey ?? null;
  const polishedReason = key ? ai.polished.get(key) ?? null : null;

  return {
    candidateKey: key,
    module: item.module,
    skill: item.skill,
    primarySkill: item.primarySkill,
    track: item.track,
    planDate,
    plannedMinutes: item.minutes,
    minChunkMinutes: item.minChunkMinutes,
    splittable: item.splittable,
    priority: item.priority,
    sourceKind: item.sourceKind,
    explanation: {
      reason: polishedReason ?? item.rationale,
      goalRef: goal?.targetValue ?? null,
      gapRef: decision?.meta.skillGapKey
        ? { skillGapKey: decision.meta.skillGapKey, evidenceRefs: decision.meta.evidenceRefs }
        : null,
      estMinutes: candidate?.estMinutes ?? item.minutes,
      minMinutes: candidate?.minMinutes ?? item.minChunkMinutes,
      priority: item.priority,
      prerequisites: (candidate?.prerequisites ?? []).map((p) => ({
        text: prerequisiteText(p),
        met,
      })),
      expectedOutput: candidate?.expectedOutput ?? null,
      consequenceIfSkipped: decision?.consequenceIfSkipped ?? null,
      origin: 'RULE',
      wordingSource: polishedReason ? 'AI_POLISHED' : 'TEMPLATE',
    },
    // `byAi` 的唯一赋值点（`41 §6.5`）：四个条件必须同时成立。
    byAi:
      ai.mode === 'on' &&
      candidate?.isAiSuggested === true &&
      decision?.eligibility === 'ELIGIBLE' &&
      key !== null &&
      ai.picks.has(key),
    aiCallLogId:
      key !== null && ai.picks.has(key)
        ? ai.suggestLogId
        : polishedReason
          ? ai.explainLogId
          : null,
  };
}

/** 汇总多天的取舍区（比例用「已安排总分钟」做分母，保证三比例之和 ≈ 1）。 */
function aggregateTradeoffs(
  days: { result: ReturnType<typeof generateAdaptivePlan> }[],
): PlanTradeoffs {
  let total = 0;
  let p0 = 0;
  let core = 0;
  let extensive = 0;
  const excludedByBudget: PlanTradeoffs['excludedByBudget'] = [];
  const uncertaintyDeferred: PlanTradeoffs['uncertaintyDeferred'] = [];
  const silentSkills: PlanTradeoffs['silentSkills'] = [];

  for (const day of days) {
    if (!day.result.ok) continue;
    total += day.result.totalPlannedMinutes;
    p0 += day.result.priorityMinutes.P0;
    core += day.result.priorityMinutes.P1 + day.result.priorityMinutes.P2;
    extensive += day.result.priorityMinutes.P3;
    for (const entry of day.result.backlog) {
      if (entry.kind === 'RETEST') {
        uncertaintyDeferred.push({ skill: entry.label, why: entry.reason });
      } else if (entry.kind === 'SKILL_ROTATION') {
        silentSkills.push({ skill: entry.label, why: entry.reason });
      } else {
        excludedByBudget.push({ title: entry.label, minutes: entry.minutes, reason: entry.reason });
      }
    }
  }

  return {
    excludedByBudget,
    p0Ratio: total > 0 ? p0 / total : 0,
    coreRatio: total > 0 ? core / total : 0,
    extensiveRatio: total > 0 ? extensive / total : 0,
    uncertaintyDeferred,
    silentSkills,
  };
}

/** MONTH/CYCLE 层 8 项结构（`41 §5.2`）。明细任务只到 WEEK/DAY，这里只产结构。 */
function buildLayerStructure(
  layer: 'MONTH' | 'CYCLE',
  context: PlanEngineContextV27,
  asOfDate: string,
): PlanLayerStructure {
  const allocation: SkillAllocation =
    context.legacy.allocation ?? { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 };
  const stageCode = context.stage.code;
  const goalText = context.goal?.targetValue ?? context.goal?.targetDate ?? '当前阶段';
  const milestoneCount = layer === 'MONTH' ? 4 : 13;
  const weeklyMilestones: WeeklyMilestone[] = Array.from({ length: milestoneCount }, (_, index) => ({
    week: index + 1,
    startDate: addDaysForMilestone(asOfDate, index * 7),
    goal: `第 ${index + 1} 周：完成本周候选任务与四技能训练，保持配比 L${allocation.LISTENING}/R${allocation.READING}/S${allocation.SPEAKING}/W${allocation.WRITING}`,
  }));

  return {
    layer,
    stageGoal: `在 ${stageCode} 阶段完成「${goalText}」的训练目标`,
    weeklyMilestones,
    skillAllocation: allocation,
    weeklyTests: '每周完成一次到期证据复测（D7/D14）与阶段核心任务验收，校验证据链不中断',
    materialSuggestions: '按候选池建议选用主材料：精听、精读、口语输出、写作各一项，未就绪材料不进计划',
    vocabGrammarScope: '词汇复习与语法句型训练属于支持性时间，不进入四技能配比分母',
    acceptanceCriteria: '阶段验收：听力/阅读/口语/写作/语法各至少 1 项 PASSED（H1 必验项）',
    adjustmentConditions: '预算变更走重排流程；上游版本变更只打 stale，不自动改写已确认计划',
  };
}

/** 里程碑起始日（MONTH/CYCLE 结构专用，纯字符串加法）。 */
function addDaysForMilestone(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 规则层的一日结果（`assembleDraft` 之前），AI 需要它来判断「哪些候选真的进了计划」。 */
interface RuleDayPlan {
  date: string;
  budgetMinutes: number;
  isRestDay: boolean;
  result: ReturnType<typeof generateAdaptivePlan>;
}

const AI_OFF: AiApplication = {
  mode: 'off',
  note: '本次由规则生成，AI 未参与',
  picks: new Set(),
  polished: new Map(),
  suggestLogId: null,
  explainLogId: null,
};

interface AiLayerResult extends AiApplication {
  rejected: BuildPlanResult['rejectedAiSuggestions'];
}

function aiFailureNote(code: string, message: string): string {
  if (code === 'INVALID_OUTPUT') return 'AI 输出未通过校验，已回落规则输出（INVALID_OUTPUT）';
  if (code === 'BUDGET_EXCEEDED') return 'AI 调用被预算拦截（BUDGET_EXCEEDED），已回落规则输出';
  return `AI 调用失败（${code}），已回落规则输出：${message}`;
}

function factorSummaryOf(decision: CandidateDecisionPair['decision']): string {
  return PRIORITY_FACTOR_KEYS.map(
    (key) => `${FACTOR_LABEL_ZH[key]} ${decision.factors[key].toFixed(2)}`,
  ).join(' / ');
}

/**
 * AI 层（`41 §6`）：只润色措辞、从池中挑候选、记周主题（本函数不调周主题）。
 *
 * 状态机不可逆：任一调用失败 → `failed`，**丢弃全部 AI 效果**（不保留半截润色），
 * 计划照常返回（AC-17）。单条建议被拒（池外 / 超预算）**不降级**，只记录。
 */
async function applyAiLayer(args: {
  allowAi: boolean | undefined;
  snapshotId: string;
  asOfDate: string;
  pool: TaskCandidateDraft[];
  pairByKey: Map<string, CandidateDecisionPair>;
  ruleDays: RuleDayPlan[];
  budgetDays: { date: string; minutes: number; isRestDay: boolean }[];
}): Promise<AiLayerResult> {
  if (args.allowAi !== true) return { ...AI_OFF, rejected: [] };
  if (!(await planAiAvailable(prisma))) return { ...AI_OFF, rejected: [] };

  const scheduledKeys = new Set<string>();
  for (const day of args.ruleDays) {
    if (!day.result.ok) continue;
    for (const item of day.result.items) {
      if (item.candidateKey) scheduledKeys.add(item.candidateKey);
    }
  }

  const dayBudget =
    args.budgetDays.find((day) => day.date === args.asOfDate) ?? args.budgetDays[0] ?? null;
  const plannedToday = args.ruleDays
    .filter((day) => day.date === (dayBudget?.date ?? ''))
    .reduce(
      (total, day) =>
        total + (day.result.ok ? day.result.items.reduce((sum, item) => sum + item.minutes, 0) : 0),
      0,
    );
  const remaining = dayBudget ? Math.max(0, dayBudget.minutes - plannedToday) : 0;

  const suggest = await suggestCandidateOrder({
    prisma,
    snapshotId: args.snapshotId,
    pool: args.pool,
    budgetMinutes: dayBudget?.minutes ?? 0,
    dailyBudgets: args.budgetDays,
  });
  if (!suggest.ok) {
    return {
      ...AI_OFF,
      mode: 'failed',
      note: aiFailureNote(suggest.code, suggest.message),
      rejected: [],
    };
  }

  const resolved = resolveAiPicks(args.pool, suggest.picks);
  const rejected: BuildPlanResult['rejectedAiSuggestions'] = [];
  for (const pick of resolved.rejected) {
    const pair = args.pairByKey.get(pick.candidateKey);
    rejected.push({
      title: pair?.candidate.title ?? pick.candidateKey,
      reason: `${pick.code}：${pick.reason}`,
      aiCallLogId: suggest.callLogId,
    });
  }

  const acceptedScheduled: string[] = [];
  const overBudgetReason = new Map<string, string>();
  for (const pick of resolved.accepted) {
    if (scheduledKeys.has(pick.candidateKey)) {
      acceptedScheduled.push(pick.candidateKey);
      continue;
    }
    const pair = args.pairByKey.get(pick.candidateKey);
    if (!pair) continue;
    const { candidate, decision } = pair;
    if (decision.eligibility === 'BLOCKED_PREREQUISITE') {
      rejected.push({
        title: candidate.title,
        reason: `${decision.blockedReason ?? '前置条件未满足'}（AI 建议被调度器拒绝，不降级）`,
        aiCallLogId: suggest.callLogId,
      });
      continue;
    }
    const reason =
      candidate.estMinutes > remaining
        ? `OVER_BUDGET：AI 建议需要 ${candidate.estMinutes} 分钟，当日剩余 ${remaining} 分钟（整条拒绝，不按比例裁剪）`
        : '调度器未安排该候选（当日已排满或与更高优先级任务冲突），AI 建议不生效（不按比例裁剪）';
    overBudgetReason.set(candidate.candidateKey, reason);
    rejected.push({ title: candidate.title, reason, aiCallLogId: suggest.callLogId });
  }

  // ── 润色：失败即整条回落，已采纳的 picks 也一并丢弃（failed 不保留半截结果） ──
  const seeds: TaskExplanationSeed[] = [];
  for (const day of args.ruleDays) {
    if (!day.result.ok) continue;
    for (const item of day.result.items) {
      if (!item.candidateKey) continue;
      const pair = args.pairByKey.get(item.candidateKey);
      if (!pair) continue;
      seeds.push({
        candidateKey: item.candidateKey,
        module: item.module,
        skill: item.skill,
        priority: item.priority,
        factorSummary: factorSummaryOf(pair.decision),
        templateReason: item.rationale,
        evidenceSummary:
          pair.decision.meta.evidenceRefs.length > 0
            ? pair.decision.meta.evidenceRefs.slice(0, 3).join(', ')
            : pair.decision.meta.noObservation
              ? '近 28 天无观察'
              : '无关联证据',
      });
    }
  }

  const polished = new Map<string, string>();
  let explainLogId: string | null = null;
  if (seeds.length > 0) {
    const explain = await polishExplanations({
      prisma,
      snapshotId: args.snapshotId,
      tasks: seeds,
    });
    if (!explain.ok) {
      return {
        ...AI_OFF,
        mode: 'failed',
        note: aiFailureNote(explain.code, explain.message),
        rejected: [],
      };
    }
    explainLogId = explain.callLogId;
    for (const [key, reason] of explain.polished) {
      const pair = args.pairByKey.get(key);
      if (!pair) continue;
      const check = assertReasonOnlyChanged(pair.decision, { ...pair.decision, rationale: reason });
      if (!check.ok) {
        rejected.push({
          title: pair.candidate.title,
          reason: `${check.code}：AI 改动了 ${check.fields.join('、')}`,
          aiCallLogId: explainLogId,
        });
        continue;
      }
      polished.set(key, reason);
    }
  }

  // ── 记账：采纳写回快照元数据（不是计划行）；超预算写回决策资格 ──
  if (acceptedScheduled.length > 0) {
    await prisma.taskCandidate.updateMany({
      where: { snapshotId: args.snapshotId, candidateKey: { in: acceptedScheduled } },
      data: { isAiSuggested: true, aiCallLogId: suggest.callLogId },
    });
    const accepted = new Set(acceptedScheduled);
    for (const candidate of args.pool) {
      if (!accepted.has(candidate.candidateKey)) continue;
      candidate.isAiSuggested = true;
      candidate.aiCallLogId = suggest.callLogId;
    }
  }
  if (overBudgetReason.size > 0) {
    const rows = await prisma.taskCandidate.findMany({
      where: { snapshotId: args.snapshotId, candidateKey: { in: [...overBudgetReason.keys()] } },
      select: { id: true, candidateKey: true },
    });
    for (const row of rows) {
      await prisma.taskPriorityDecision.updateMany({
        where: { snapshotId: args.snapshotId, candidateId: row.id },
        data: {
          eligibility: 'REJECTED_AI_OVER_BUDGET',
          blockedReason: overBudgetReason.get(row.candidateKey) ?? 'AI 建议被调度器拒绝',
        },
      });
    }
  }

  const picks = new Set(acceptedScheduled);
  const note =
    suggest.picks.length === 0
      ? 'AI 未给出候选建议'
      : picks.size === 0
        ? 'AI 建议全部被调度器拒绝'
        : `AI 已参与：采纳 ${picks.size} 条候选建议，润色 ${polished.size} 条理由`;

  return {
    mode: 'on',
    note,
    picks,
    polished,
    suggestLogId: suggest.callLogId,
    explainLogId,
    rejected,
  };
}

/**
 * 编排一次计划预览（**零写 PlanTask/PlanVersion**）。
 *
 * @param input 用途 / 基准日 / 视野 / 阶段
 */
export async function buildPlan(input: BuildPlanInput): Promise<ActionResult<BuildPlanResult>> {
  const snapshot = await buildPlanningSnapshot({
    purpose: input.purpose,
    asOfDate: input.asOfDate,
    horizonDays: input.horizonDays,
    stageId: input.stageId,
    planDate: input.planDate,
  });
  if (!snapshot.ok) return fail(snapshot.code, snapshot.error);

  const { snapshotId, inputHash, ruleVersion, weightsVersion, context } = snapshot.data;
  const layer = layerOf(input.horizonDays);
  const warnings: string[] = [...context.validation.warnings];

  // ── 配比合法性（AC-4 ⑪）：档案存在但 Σ≠100 → 拒绝，不做任何配平 ──
  // `activeAllocationFor` 对「无档案」和「档案损坏」都返回 null，两者必须可区分：
  // 前者合法回落默认值，后者必须 fail('VALIDATION')（不能静默配平成 25/25/25/25）。
  if (context.stage.profileCode) {
    const profileRow = await prisma.skillAllocationProfile.findFirst({
      where: { profileCode: context.stage.profileCode, isActive: true },
      orderBy: { effectiveFrom: 'desc' },
      select: { listeningPct: true, readingPct: true, speakingPct: true, writingPct: true },
    });
    if (profileRow) {
      const allocation: SkillAllocation = {
        LISTENING: profileRow.listeningPct,
        READING: profileRow.readingPct,
        SPEAKING: profileRow.speakingPct,
        WRITING: profileRow.writingPct,
      };
      const check = checkAllocation(allocation);
      if (!check.ok) {
        const total =
          allocation.LISTENING + allocation.READING + allocation.SPEAKING + allocation.WRITING;
        return fail('VALIDATION', `技能配比四项之和必须为 100，当前为 ${total}（不做配平）`);
      }
    }
  }

  // ── bufferRatio 来自 PlannerSettings.priorityPolicy（缺失回落 0） ──
  const settings = await getPlannerSettings();
  const bufferRatio = bufferRatioOf(settings?.priorityPolicy);

  // ── 候选 → RankedCandidateInput[]（candidates 与 decisions 同序，§3.1） ──
  const kindByKey = gapKindByKey([...context.gaps, ...context.uncertainties, ...context.unknowns]);
  // 身份键反查 decision（**不是 rationale**）：rationale 是文案，同主导因子 + 同 estMinutes
  // 的候选会产出相同字符串 → Map 覆盖 → 解释字段张冠李戴（缺陷 #1）。
  const pairByCandidateKey = new Map<string, CandidateDecisionPair>();
  const candidates: RankedCandidateInput[] = context.candidates.map((candidate, index) => {
    const decision = context.decisions[index];
    if (decision) pairByCandidateKey.set(candidate.candidateKey, { candidate, decision });
    return {
      candidateKey: candidate.candidateKey,
      module: candidate.module,
      primarySkill: candidate.primarySkill,
      track: candidate.track,
      estMinutes: candidate.estMinutes,
      minMinutes: candidate.minMinutes,
      maxBlockMinutes: candidate.maxBlockMinutes,
      priority: decision.priority,
      // 可拆 = 预计分钟大于最小单元（与 T06b 的 `plannedMinutes > minChunkMinutes` 同口径）
      splittable: candidate.estMinutes > candidate.minMinutes,
      rationale: decision.rationale,
      score: decision.score,
      sourceKind: mapCandidateSourceToPlanTask(
        candidate.sourceKind,
        kindByKey.get(candidate.skillGapKey ?? '') ?? null,
      ),
    };
  });

  // ── UNCERTAINTY → UncertaintyProbeInput[] ──
  const uncertainties: UncertaintyProbeInput[] = context.uncertainties.map((gap) => {
    const axes = probeAxesOf(gap.skill);
    return {
      skillGapKey: `${gap.dimensionKind}:${gap.skill}:${gap.subskill}`,
      module: axes.module,
      primarySkill: axes.primarySkill,
      minutes: CANDIDATE_DEFAULT_MINUTES.PROBE,
      reason: gap.reason,
    };
  });

  // ── GAP → SkillGapHint[]（只影响 rationale，不改变分配） ──
  const skillGaps: SkillGapHint[] = context.gaps.map((gap) => ({
    dimensionKind: gap.dimensionKind,
    skill: gap.skill,
    subskill: gap.subskill,
    severity: gap.severity,
    reason: gap.reason,
  }));

  // ── 预算覆盖只作用于 asOfDate 当日 ──
  const budgetDays = context.budgetDays.map((day) =>
    input.budgetOverrideMinutes !== undefined && day.date === input.asOfDate
      ? { ...day, minutes: input.budgetOverrideMinutes, isRestDay: input.budgetOverrideMinutes === 0 }
      : day,
  );

  let layerStructure: PlanLayerStructure | null = null;
  const ruleDays: RuleDayPlan[] = [];

  if (layer === 'MONTH' || layer === 'CYCLE') {
    // MONTH/CYCLE 只产结构、不排明细任务（PRD P2-05）
    layerStructure = buildLayerStructure(layer, context, input.asOfDate);
  } else {
    for (const day of budgetDays) {
      const result = generateAdaptivePlan({
        ...context.legacy,
        budgetMinutes: day.minutes,
        isRestDay: day.isRestDay,
        tierCode: tierCodeOf(day.minutes),
        bufferRatio,
        candidates,
        uncertainties,
        skillGaps,
      });
      ruleDays.push({ date: day.date, budgetMinutes: day.minutes, isRestDay: day.isRestDay, result });
      if (result.ok) warnings.push(...result.warnings);
    }
  }

  // ── aiMode 三态：规则结果先算完，AI 只能润色措辞/挑候选，不能改调度字段 ──
  const ai = await applyAiLayer({
    allowAi: input.allowAi,
    snapshotId,
    asOfDate: input.asOfDate,
    pool: context.candidates,
    pairByKey: pairByCandidateKey,
    ruleDays,
    budgetDays,
  });

  const days: BuildPlanResult['days'] = ruleDays.map((day) => ({
    date: day.date,
    budgetMinutes: day.budgetMinutes,
    isRestDay: day.isRestDay,
    tasks: day.result.ok
      ? day.result.items.map((item) =>
          assembleDraft(
            item,
            day.date,
            context.goal,
            pairByCandidateKey.get(item.candidateKey ?? '') ?? null,
            ai,
          ),
        )
      : [],
  }));

  const tradeoffs = aggregateTradeoffs(ruleDays.map((day) => ({ result: day.result })));

  return ok({
    snapshotId,
    inputHash,
    ruleVersion,
    weightsVersion,
    aiMode: ai.mode,
    aiNote: ai.note,
    horizonDays: input.horizonDays,
    days,
    tradeoffs,
    rejectedAiSuggestions: ai.rejected,
    warnings,
    preview: true,
    layerStructure,
    layer,
  });
}
