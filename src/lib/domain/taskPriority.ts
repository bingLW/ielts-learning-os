/**
 * 候选评分（T04）：七个因子 → 一条可解释的优先级决策。
 *
 * 本文件**无 IO**：不 import `prisma`、不查库、不读时钟。所有输入来自 `ScoreContext`，
 * 其中 `gaps` 必须由调用方从**快照/DTO**传入（`41` §9.1 C-H）——
 * `SkillGap` 表里没有 `evidenceQuestions` / `repeatedErrorCount` 两列，从表里读回来的
 * 缺口天生缺这两个字段，于是 `errorRecurrence` 恒 `0`、`noObservation` 恒 `false`，
 * 整套标注静默失效且不报错。
 *
 * 三条贯穿全程的判据：
 *
 * 1. **回落值只问一句：这个「缺失」是「确认为无」还是「不知道」？**
 *    确认为无 → `0.00`；不知道 → 中性值（`0.30`~`0.50`）。把"不知道"写成 0 不是保守，
 *    而是**把缺失当成负面证据** —— 一个从没测过的维度会被系统性压低，永远排不上。
 * 2. **`timeCost` 与预算无关**：用 `minTaskMinutes / max(minMinutes, estMinutes)`。
 *    写成 `estMinutes / budgetMinutes` 会让同一候选在不同预算日得分不同，
 *    决策轨迹不可复算（用户问"为什么昨天它排前面"就永远答不出）。
 * 3. **`P0` 不由分数决定**：到期复习/复测恒 `P0`，`score` 只在 P0 内部排序。
 *    否则一次高 `goalRelevance` 的拓展任务就能把到期复习挤到 P1（AC-7）。
 */

import {
  DEFAULT_PRIORITY_WEIGHTS,
  PRIORITY_CONFIDENCE_WEIGHT,
  PRIORITY_EVIDENCE_NO_GAP,
  PRIORITY_FACTOR_KEYS,
  PRIORITY_GOAL_HORIZON_DAYS,
  PRIORITY_GOAL_UNRELATED,
  PRIORITY_NEUTRAL_VALUE,
  PRIORITY_THRESHOLDS,
  PRIORITY_URGENCY_DUE_BASE,
  PRIORITY_URGENCY_MAX_OVERDUE_DAYS,
  PRIORITY_URGENCY_OVERDUE_STEP,
  PRIORITY_WEIGHTS_VERSION,
  WEAKNESS_MIN_QUESTIONS,
  type PriorityFactorKey,
} from '../constants';
import { diffDays } from '../date';
import type { LearningTrack, ModuleId, SkillId, TaskEstimate, TaskPriority } from '../types';
import { clamp01, type SkillGapDraft } from './skillGap';
import {
  evaluatePrerequisites,
  type PrerequisiteContext,
  type TaskCandidateDraft,
} from './taskCandidate';

/** 权重版本（与 `PRIORITY_WEIGHTS_VERSION` 同源，导出只为让调用点少 import 一处）。 */
export const WEIGHTS_VERSION = PRIORITY_WEIGHTS_VERSION;

/** 七因子权重。键集由 `PriorityFactorKey` 钉死。 */
export type PriorityWeights = Record<PriorityFactorKey, number>;

/** 默认权重（Σ = 1）。 */
export const DEFAULT_WEIGHTS: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS;

/** 七个因子的原始值（0..1，**越大越该排**）。恰好 7 个键。 */
export type FactorTrace = Record<PriorityFactorKey, number>;

/**
 * 评分需要的目标信息。
 *
 * 刻意**不复用** `services/planningSnapshot.ts` 的 `PlanEngineContextV27['goal']`：
 * `domain/` 不许 import `services/`（`41 §1.7` 依赖方向）。这里是结构等价的
 * domain 侧声明，服务层对象可直接传入。
 */
export interface PriorityGoal {
  track: LearningTrack;
  targetValue: string | null;
  targetDate: string | null;
  /** `Partial` 是刻意的：未列出的技能 = "不在目标内"，读取侧不许当 0。 */
  skillTargets: Partial<Record<SkillId, number>>;
  /**
   * 是否有在跑的 `LearningCycle`。
   *
   * 单独一个布尔而不是直接传 `startDate`：`goalRelevance` 的公式
   * `1 − clamp01(remaining/90)` 前提是**有 90 天周期在跑**。缺周期时若用
   * `diffDays(undefined, …)`，`diffDays` 会**退化成 0**，公式自然算出 `1 − 0 = 1.00`
   * —— 所有候选满分、因子彻底失效，而且看起来完全正常（见 `41 §2.4.1` 陷阱）。
   * 所以要有一个**显式**的"有没有周期"信号，不能靠公式自然得出。
   */
  hasActiveCycle: boolean;
}

/** 评分上下文。 */
export interface ScoreContext {
  asOfDate: string;
  /**
   * 当日预算。
   *
   * **只用于解释文案**（"预计 8 分钟，今日预算 60 分钟"）。**不许进 `timeCost`**：
   * 用 `est/budget` 会让同一候选在不同预算日得分不同，决策轨迹不可复算。
   */
  budgetMinutes: number;
  /** 最小任务粒度（`timeCost` 的唯一尺度来源）。 */
  minTaskMinutes: number;
  goal: PriorityGoal | null;
  /** 缺口（**必须来自快照/DTO**，见文件头）。 */
  gaps: readonly SkillGapDraft[];
  weights: PriorityWeights;
  /**
   * 本次评分用的权重版本。
   *
   * **由调用方给，不从常量读**：否则"用一份自定义权重算出来的分数"会被标上默认版本号，
   * 历史决策永远对不上它的权重表 —— 那正是「`weightsVersion` 只存不用」的反面形态
   * （存了、但存的是别人的）。
   */
  weightsVersion: string;
  /** 用户对模块的偏好；无信号时 `undefined` → 因子取中性 0.50。 */
  preferenceByModule?: Partial<Record<ModuleId, number>>;
  /** 前置条件判定上下文（由调用方读库后传入，本模块不查）。 */
  prerequisites: PrerequisiteContext;
}

/** 资格判定。 */
export type Eligibility =
  | 'ELIGIBLE'
  | 'BLOCKED_PREREQUISITE'
  | 'OVER_BUDGET'
  | 'DUPLICATE'
  | 'REJECTED_NOT_IN_POOL'
  | 'REJECTED_AI_OVER_BUDGET';

/**
 * 决策的审计元信息。**与七因子分层存放**，绝不平铺（`41 §2.4.3`）：
 * 平铺会让"按 `Object.entries` 求加权和"的实现取到 `weights['noObservation']`
 * → `undefined` → `score` 变 `NaN` → `sort` 不抛错、只静默乱序。
 */
export interface DecisionMeta {
  estMinutesSource: 'SOURCE' | 'DERIVED';
  derivedFrom?: string;
  /** 生成时的估时快照；AI 只能改 rationale，不得改此字段。 */
  estimate?: TaskEstimate;
  /** 候选归属/阶段元数据，随决策快照保存。 */
  candidateMeta?: TaskCandidateDraft['meta'];
  skillGapKey: string | null;
  /** 支撑该缺口的证据 id（可追溯，AC-8）。无缺口时为空数组。 */
  evidenceRefs: string[];
  /**
   * 「近 28 天这个维度**没有观察**」（而不是「确认没有重复错误」）。
   *
   * 两种情况的因子值都是 `0.00`（错误重复度是**加重因子**不是发现因子），
   * 但 UI 必须显示不同的话：前者是"近 28 天无记录（未观察）"，后者是"0 次错误"。
   */
  noObservation: boolean;
}

/** 一条决策（落库前的形状）。 */
export interface TaskPriorityDecisionDraft {
  candidateKey: string;
  weightsVersion: string;
  /** 恰好 7 个键，键集 == `DEFAULT_WEIGHTS` 的键集。 */
  factors: FactorTrace;
  /** 加权总分 0..1（有限数，非有限直接抛）。 */
  score: number;
  priority: TaskPriority;
  rationale: string;
  /** 若不做的影响；`null` = 无法判断（UI 必须显示「无法判断」，不许编造）。 */
  consequenceIfSkipped: string | null;
  eligibility: Eligibility;
  blockedReason: string | null;
  meta: DecisionMeta;
}

/** 因子的人话名（解释面板用）。 */
export const FACTOR_LABEL_ZH: Record<PriorityFactorKey, string> = {
  urgency: '到期压力',
  goalRelevance: '目标相关度',
  evidenceStrength: '证据支撑',
  errorRecurrence: '错误重复度',
  prerequisiteReady: '前置条件',
  timeCost: '时间性价比',
  preferenceFit: '偏好匹配',
};

// ───────────────────────── 缺口查找 ─────────────────────────

/**
 * 候选关联的缺口。
 *
 * 用 `dimensionKind:skill:subskill` 三段比对，只比对 `skill` 会把
 * "READING 技能级缺口"与"READING/detail_scanning 子缺口"混成一个 —— 而它们的
 * 严重度、证据条数完全不同。
 */
function gapOf(candidate: TaskCandidateDraft, gaps: readonly SkillGapDraft[]): SkillGapDraft | null {
  if (!candidate.skillGapKey) return null;
  const key = candidate.skillGapKey;
  return gaps.find((gap) => `${gap.dimensionKind}:${gap.skill}:${gap.subskill}` === key) ?? null;
}

// ───────────────────────── 七因子 ─────────────────────────

/**
 * ① 到期压力。
 *
 * 无 `dueDate` → **`0.00`**（"确认为无紧迫性"）。不是复习/复测任务就没有到期压力；
 * 给它中性值会把普通核心任务无端抬到 P1。
 */
function urgencyOf(candidate: TaskCandidateDraft, asOfDate: string): number {
  if (!candidate.dueDate) return 0;
  const overdueDays = diffDays(candidate.dueDate, asOfDate);
  if (!Number.isFinite(overdueDays)) return 0;
  if (overdueDays <= 0) return PRIORITY_URGENCY_DUE_BASE;
  return clamp01(
    PRIORITY_URGENCY_DUE_BASE + PRIORITY_URGENCY_OVERDUE_STEP * Math.min(overdueDays, PRIORITY_URGENCY_MAX_OVERDUE_DAYS),
  );
}

/**
 * ② 目标相关度。
 *
 * 三个"不知道"分支**显式判空**，绝不靠公式自然得出：
 * 无目标 / 无在跑周期 / 无目标日 → `0.50`。
 *
 * 走公式时两种错法都"看起来正常"：`remaining = 0` → `1.00`（所有候选满分、因子失效）；
 * `remaining = ∞` → `0.00`（所有候选同等打压）。而错法一之所以"自然"，是因为
 * 缺周期时 `diffDays(undefined, …)` 会退化成 `0`。
 */
function goalRelevanceOf(candidate: TaskCandidateDraft, ctx: ScoreContext): number {
  const goal = ctx.goal;
  if (!goal) return PRIORITY_NEUTRAL_VALUE;
  if (!goal.hasActiveCycle) return PRIORITY_NEUTRAL_VALUE;
  if (!goal.targetDate) return PRIORITY_NEUTRAL_VALUE;
  // 有目标、但这门技能不在目标内 → "确认为无直接关系"，不是"不知道"
  if (!(candidate.targetSkill in goal.skillTargets)) return PRIORITY_GOAL_UNRELATED;
  const remainingDays = diffDays(ctx.asOfDate, goal.targetDate);
  // 目标日是脏值（`diffDays` 给 NaN）→ 当作"没有目标日"，不许 clamp 成 1.00
  if (!Number.isFinite(remainingDays)) return PRIORITY_NEUTRAL_VALUE;
  return clamp01(1 - clamp01(remainingDays / PRIORITY_GOAL_HORIZON_DAYS));
}

/**
 * ③ 证据支撑强度 = 缺口严重度 × 置信权重。
 *
 * 未关联缺口 → **`0.30`（中性偏低，不是打压到 0）**：
 * "无缺口关联 ≠ 无价值"，阶段核心训练本来就可能不对应任何缺口。
 * `0.20 × 0.30 = 0.06` 与 `0` 的差，足以让同一候选在阈值边界上从 P2 掉到 P3。
 */
function evidenceStrengthOf(gap: SkillGapDraft | null): number {
  if (!gap) return PRIORITY_EVIDENCE_NO_GAP;
  return clamp01(gap.severity * PRIORITY_CONFIDENCE_WEIGHT[gap.confidence]);
}

/**
 * ④ 同类错误重复度。
 *
 * 三个状态必须分开：
 * - 无缺口 → `0.00`，`noObservation=false`（没有维度，谈不上"没观察"）；
 * - 有缺口但 `evidenceQuestions === 0` → `0.00`，**`noObservation=true`**（没练过 ≠ 没错误）；
 * - 有缺口且练过 → 按 `repeatedErrorCount` 折算，`repeatedErrorCount === null` 记 `0`
 *   （"不知道次数"不该被当成"错了很多次"，也不该被当成"确认没有" —— 所以它同时
 *   标 `noObservation`，见下方实现）。
 */
function errorRecurrenceOf(gap: SkillGapDraft | null): { value: number; noObservation: boolean } {
  if (!gap) return { value: 0, noObservation: false };
  if (gap.evidenceQuestions <= 0) return { value: 0, noObservation: true };
  if (gap.repeatedErrorCount === null) return { value: 0, noObservation: true };
  return {
    value: clamp01(gap.repeatedErrorCount / (WEAKNESS_MIN_QUESTIONS * 2)),
    noObservation: false,
  };
}

/** ⑤ 前置条件（二值，没有中性档）。 */
function prerequisiteReadyOf(
  candidate: TaskCandidateDraft,
  ctx: ScoreContext,
): { value: number; unmet: ReturnType<typeof evaluatePrerequisites>['unmet'] } {
  const { ready, unmet } = evaluatePrerequisites(candidate.prerequisites, ctx.prerequisites);
  return { value: ready ? 1 : 0, unmet };
}

/**
 * ⑥ 时间性价比 = `minTaskMinutes / max(minMinutes, estMinutes)`。
 *
 * **与预算无关**（见文件头第 2 条）。越短越高：同条件下先做短的，提高装箱成功率。
 * 分母为 0（脏数据）时给 1 —— 0 分钟任务在装箱时"永远放得下"，那就该排最前，
 * 而不是让 `0/0 = NaN` 把整条分数打坏。
 */
function timeCostOf(candidate: TaskCandidateDraft, minTaskMinutes: number): number {
  const denominator = Math.max(candidate.minMinutes, candidate.estMinutes);
  if (!Number.isFinite(denominator) || denominator <= 0) return 1;
  const scale = Number.isFinite(minTaskMinutes) && minTaskMinutes > 0 ? minTaskMinutes : 1;
  return clamp01(scale / denominator);
}

/** ⑦ 偏好匹配：无偏好 → `0.50`（"不知道偏好"，不是"不喜欢"）。 */
function preferenceFitOf(candidate: TaskCandidateDraft, ctx: ScoreContext): number {
  const raw = ctx.preferenceByModule?.[candidate.module];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return PRIORITY_NEUTRAL_VALUE;
  return clamp01(raw);
}

// ───────────────────────── 分层 ─────────────────────────

/**
 * 分层：`P0` 由**来源 + 到期**决定，不由分数决定。
 *
 * 其余按 `score ≥ 0.60 → P1`、`≥ 0.42 → P2`、否则 `P3`。
 * 只对 `REVIEW`/`RETEST` 生效：`PROBE` 虽然落库时映射成 `RETEST`，但它是
 * "证据不足先测一下"，不是到期复习，不该无条件占 P0。
 */
export function priorityOf(
  score: number,
  candidate: Pick<TaskCandidateDraft, 'sourceKind' | 'dueDate'>,
  asOfDate: string,
): TaskPriority {
  const isDueReview =
    (candidate.sourceKind === 'REVIEW' || candidate.sourceKind === 'RETEST') &&
    typeof candidate.dueDate === 'string' &&
    candidate.dueDate <= asOfDate;
  if (isDueReview) return 'P0';
  if (!Number.isFinite(score)) return 'P3';
  if (score >= PRIORITY_THRESHOLDS.p1) return 'P1';
  if (score >= PRIORITY_THRESHOLDS.p2) return 'P2';
  return 'P3';
}

// ───────────────────────── 排序（全仓唯一一处） ─────────────────────────

/** 分层的排序权重（`P0` 最前）。 */
const PRIORITY_RANK: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * 决策的比较函数：`priority` 升序 → `score` 降序 → `candidateKey` 升序。
 *
 * 三个键缺一不可，理由各不相同：
 * 1. **`priority` 必须在 `score` 之前**：否则一条 `score=0.99` 的 P3 拓展会排到
 *    `score=0.10` 的 P0 到期复习前面 —— 那是在渲染层把「P0 是约定不是排名」直接破掉，
 *    而页面看起来完全正常（两条都在今天的列表里，只是顺序不同）。
 * 2. **`score` 降序**：同层内先做更值得的。
 * 3. **`candidateKey` 升序兜底**：`urgency` / `goalRelevance` 都是**离散回落值**
 *    （0.40 / 0.50 / 0.30…），撞分极常见；没有末位键，兜底就变成"数据库返回顺序"，
 *    而 `dev.db` 的行序在 `VACUUM` / 重建表之后会变。
 */
export function compareDecisions(a: TaskPriorityDecisionDraft, b: TaskPriorityDecisionDraft): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  const aProposalOrder = a.meta.candidateMeta?.diagnosticProposal?.order;
  const bProposalOrder = b.meta.candidateMeta?.diagnosticProposal?.order;
  const aIsProposal = aProposalOrder !== undefined;
  const bIsProposal = bProposalOrder !== undefined;
  if (aIsProposal !== bIsProposal) return aIsProposal ? -1 : 1;
  if (aIsProposal && bIsProposal && aProposalOrder !== bProposalOrder) {
    return aProposalOrder - bProposalOrder;
  }
  if (a.score !== b.score) return b.score - a.score;
  return a.candidateKey < b.candidateKey ? -1 : a.candidateKey > b.candidateKey ? 1 : 0;
}

/**
 * 把决策排成**唯一确定**的顺序。
 *
 * 这是全仓唯一允许决定"先做哪条"的地方。`adaptivePlan` 必须按传入顺序消费、
 * 不得二次排序 —— 否则同一份数据有两处决定顺序，「可复算」立刻失效
 * （用户看到 A 在 B 前面，重算一次却变了，而两处代码各自都"没错"）。
 *
 * 纯函数、不改入参。
 *
 * @param decisions 决策列表（顺序任意）
 */
export function rankDecisions(
  decisions: readonly TaskPriorityDecisionDraft[],
): TaskPriorityDecisionDraft[] {
  return [...decisions].sort(compareDecisions);
}

// ───────────────────────── 解释文案 ─────────────────────────

/** 主导因子（加权贡献最大者）——解释面板先说这一句。 */
function dominantFactor(factors: FactorTrace, weights: PriorityWeights): PriorityFactorKey {
  let best: PriorityFactorKey = PRIORITY_FACTOR_KEYS[0];
  let bestContribution = -1;
  for (const key of PRIORITY_FACTOR_KEYS) {
    const contribution = factors[key] * weights[key];
    if (contribution > bestContribution) {
      bestContribution = contribution;
      best = key;
    }
  }
  return best;
}

function rationaleOf(
  candidate: TaskCandidateDraft,
  factors: FactorTrace,
  ctx: ScoreContext,
  priority: TaskPriority,
): string {
  const dominant = dominantFactor(factors, ctx.weights);
  const head = priority === 'P0' ? '到期任务，固定 P0' : `${FACTOR_LABEL_ZH[dominant]} ${factors[dominant].toFixed(2)} 主导`;
  const range = candidate.meta.estimate
    ? `${candidate.meta.estimate.minMinutes}–${candidate.meta.estimate.maxMinutes}`
    : `${candidate.estMinutes}`;
  const calibration = candidate.meta.estimate?.basis === 'CALIBRATED' ? '，历史校准' : '，估计';
  return `${head}；预计 ${range} 分钟${calibration}，今日预算 ${ctx.budgetMinutes} 分钟`;
}

/**
 * 若不做会怎样。**可判才给**，判不了给 `null` —— UI 显示「无法判断」而不是编一句话。
 */
function consequenceOf(candidate: TaskCandidateDraft, gap: SkillGapDraft | null): string | null {
  if (candidate.dueDate) return `今天不做，明天起进入逾期（到期日 ${candidate.dueDate}）`;
  if (gap && gap.kind === 'GAP') {
    const dimension = gap.subskill ? `${gap.skill}/${gap.subskill}` : gap.skill;
    return `该缺口（${dimension}）的证据不会增加，下次排课仍会排在同类位置`;
  }
  return null;
}

// ───────────────────────── 加权求和 ─────────────────────────

/**
 * 加权总分。
 *
 * **遍历的是权重表，不是 `factors` 的键**：`factors` 里就算被塞了多余字段
 * （`noObservation` / `_meta` / 未来的任何标注），求和也不受影响。
 * 反过来写（`for (const [k, v] of Object.entries(factors))`）会取到
 * `weights['noObservation'] === undefined` → `0.12 * undefined = NaN`，
 * 而 `NaN` 参与比较恒 `false` —— `sort` 不抛错、只产出看似正常但顺序随机的计划。
 *
 * @param factors 七因子原始值
 * @param weights 权重表（键集决定参与求和的项）
 */
export function weightedScore(factors: FactorTrace, weights: PriorityWeights): number {
  let score = 0;
  for (const key of PRIORITY_FACTOR_KEYS) {
    score += weights[key] * factors[key];
  }
  // `NaN` 必须在落库前暴露
  if (!Number.isFinite(score)) {
    throw new Error('加权总分不是有限数（权重或因子含 NaN）');
  }
  return score;
}

// ───────────────────────── 主函数 ─────────────────────────

/**
 * 给一条候选打分。
 *
 * @param candidate 归一后的候选（`dueDate` 由采集层填，本函数不查源表）
 * @param ctx 评分上下文（`gaps` 必须来自快照/DTO）
 */
export function scoreCandidate(
  candidate: TaskCandidateDraft,
  ctx: ScoreContext,
): TaskPriorityDecisionDraft {
  const gap = gapOf(candidate, ctx.gaps);
  const recurrence = errorRecurrenceOf(gap);
  const prerequisite = prerequisiteReadyOf(candidate, ctx);

  const factors: FactorTrace = {
    urgency: urgencyOf(candidate, ctx.asOfDate),
    goalRelevance: goalRelevanceOf(candidate, ctx),
    evidenceStrength: evidenceStrengthOf(gap),
    errorRecurrence: recurrence.value,
    prerequisiteReady: prerequisite.value,
    timeCost: timeCostOf(candidate, ctx.minTaskMinutes),
    preferenceFit: preferenceFitOf(candidate, ctx),
  };

  // 求和的键**来自权重表**，不是来自 `factors`：即使有人往 factors 里塞了多余字段，
  // 加权和也不受影响（`41 §2.4.3` 约束 1）
  const score = weightedScore(factors, ctx.weights);

  const priority = priorityOf(score, candidate, ctx.asOfDate);
  const blockedReason =
    prerequisite.unmet.length === 0 ? null : unmetReason(prerequisite.unmet);

  return {
    candidateKey: candidate.candidateKey,
    weightsVersion: ctx.weightsVersion,
    factors,
    score,
    priority,
    rationale: candidate.meta.diagnosticProposal
      ? `USER_EDIT：${candidate.meta.diagnosticProposal.userReason}`
      : rationaleOf(candidate, factors, ctx, priority),
    consequenceIfSkipped: consequenceOf(candidate, gap),
    // 评分层只判"前置条件是否满足"。`OVER_BUDGET` / `DUPLICATE` 属于装箱与去重层：
    // 它们需要知道"能不能拆""同一件事是否已被别的候选占了"，这里两者都不知道，
    // 硬判会把一条可拆的长任务误标成不可排。
    eligibility: prerequisite.unmet.length === 0 ? 'ELIGIBLE' : 'BLOCKED_PREREQUISITE',
    blockedReason,
    meta: {
      estMinutesSource: candidate.meta.estMinutesSource,
      ...(candidate.meta.derivedFrom ? { derivedFrom: candidate.meta.derivedFrom } : {}),
      ...(candidate.meta.estimate ? { estimate: candidate.meta.estimate } : {}),
      candidateMeta: candidate.meta,
      skillGapKey: candidate.skillGapKey,
      evidenceRefs: candidate.meta.diagnosticProposal
        ? [candidate.meta.diagnosticProposal.evidenceRef]
        : gap?.evidenceIds ?? [],
      noObservation: recurrence.noObservation,
    },
  };
}

/** 「需先完成 X」的具体文案（用户要知道卡在哪一步）。 */
function unmetReason(unmet: readonly { kind: string }[]): string {
  const first = unmet[0];
  if (!first) return '前置条件未满足';
  return `前置条件未满足：${first.kind}（共 ${unmet.length} 项）`;
}

/**
 * 落库用的 `factorsJson` 形状：`{ factors, meta }` **两层**。
 *
 * 由本函数统一序列化，服务层不得自己拼 JSON —— 否则"平铺"这个错误有机会被写进去，
 * 而它的后果（`NaN` → 排序静默乱序）在运行时看不见。
 */
export function toFactorsJson(decision: TaskPriorityDecisionDraft): { factors: FactorTrace; meta: DecisionMeta } {
  return { factors: decision.factors, meta: decision.meta };
}

/** AI 建议复核结果：只允许 `rationale` 变化。 */
export type ReasonOnlyCheck =
  | { ok: true }
  | { ok: false; code: 'REJECTED_AI_MUTATED_DECISION'; fields: string[] };

/**
 * 检查 AI 处理前后是否**只**改了措辞（`rationale`）。
 *
 * 必须做**结构化字段比对**：比对新旧 JSON 字符串会把换行/空格差异误判成篡改，
 * 而真正危险的改动（`priority` 从 P3 变 P0、`eligibility` 从 BLOCKED 变 ELIGIBLE）
 * 只需要一个字段不同就足以绕过调度器。
 *
 * @param before 调度器产出的决策
 * @param after AI 处理后的决策（只应 `rationale` 不同）
 */
export function assertReasonOnlyChanged(
  before: TaskPriorityDecisionDraft,
  after: TaskPriorityDecisionDraft,
): ReasonOnlyCheck {
  const fields: string[] = [];
  const compare = (name: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) fields.push(name);
  };
  compare('candidateKey', before.candidateKey, after.candidateKey);
  compare('weightsVersion', before.weightsVersion, after.weightsVersion);
  compare('factors', before.factors, after.factors);
  compare('score', before.score, after.score);
  compare('priority', before.priority, after.priority);
  compare('consequenceIfSkipped', before.consequenceIfSkipped, after.consequenceIfSkipped);
  compare('eligibility', before.eligibility, after.eligibility);
  compare('blockedReason', before.blockedReason, after.blockedReason);
  compare('meta', before.meta, after.meta);
  if (fields.length > 0) {
    return { ok: false, code: 'REJECTED_AI_MUTATED_DECISION', fields };
  }
  return { ok: true };
}
