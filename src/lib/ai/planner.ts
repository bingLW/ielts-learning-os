/**
 * v2.7 规划域 AI 层（T14）。
 *
 * 三个入口，全部经 `runAiCompletion()`（`ai/orchestrator.ts`）——**不新建调用层**：
 *
 * - `polishExplanations()`：把调度器给出的模板 `reason` 润色成自然语言；
 * - `suggestCandidateOrder()`：从既有候选池中挑选并排优先级；
 * - `suggestWeeklyTheme()`：给出下周 3 个主突破主题选项。
 *
 * 三条边界（`41 §6`）：
 *
 * 1. **AI 不碰调度**：模块不 import `adaptivePlan` / `allocation` / `replan` / `stageGate`；
 *    时间、预算、复习日期、装箱结果一律由调度器决定，这里只产出措辞与排序建议。
 * 2. **归属写进日志元数据**：`AICallLog.sessionId/materialId/materialJobId` 均为 null，
 *    `snapshotId` 进 `redactedMetadataJson`（不改 AICallLog 结构）。
 * 3. **失败不抛出**：返回 `{ ok:false, code }`，由 `buildPlan` 回落规则输出（AC-17）。
 */

import type { PrismaClient } from '@prisma/client';
import type { SkillGapDraft } from '@/lib/domain/skillGap';
import type { TaskCandidateDraft } from '@/lib/domain/taskCandidate';
import { loadEngineConfig } from './config';
import { runAiCompletion } from './orchestrator';
import type { AiTurnFailureCode } from './types';

/** 一条待润色的任务摘要（只含展示所需字段，不含完整任务正文）。 */
export interface TaskExplanationSeed {
  candidateKey: string;
  module: string;
  skill: string;
  priority: string;
  /** 七因子摘要（人话，例如「到期压力 0.40 / 证据支撑 0.60」）。 */
  factorSummary: string;
  /** 调度器给出的模板理由（润色必须保留其中的事实）。 */
  templateReason: string;
  /** 关联证据摘要（无缺口时为空串）。 */
  evidenceSummary: string;
}

/** 周复盘指标（AI 只能引用，不得编造）。 */
export interface WeeklyMetricDraft {
  label: string;
  value: string;
  note?: string;
}

export interface AiPlannerFailure {
  ok: false;
  code: AiTurnFailureCode | 'NO_TASKS';
  message: string;
  callLogId: string | null;
}

/**
 * 规划域 AI 是否可用（provider 已配置）。
 *
 * 没有外部 key 时 `providerMode==='mock'`，按 `41 §6.4` 视为「provider 未配置」→ `off`，
 * 不发任何请求（内建 mock 只在教学/材料域作为离线演示用，规划域不参与判定）。
 */
export async function planAiAvailable(prisma: PrismaClient): Promise<boolean> {
  const config = await loadEngineConfig(prisma);
  return config.providerMode === 'external';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 逐候选摘要块（`planDayBlock`）。 */
export function buildPlanDayBlock(tasks: readonly TaskExplanationSeed[]): string {
  return tasks
    .map(
      (task) =>
        `- key=${task.candidateKey} | module=${task.module} | skill=${task.skill} | priority=${task.priority} | factors=${truncate(task.factorSummary, 160)} | reason=${truncate(task.templateReason, 200)} | evidence=${truncate(task.evidenceSummary, 160)}`,
    )
    .join('\n');
}

/** 候选池摘要块（`candidatePoolBlock`，最多 40 条）。 */
export function buildCandidatePoolBlock(pool: readonly TaskCandidateDraft[]): string {
  return pool
    .slice(0, 40)
    .map(
      (row) =>
        `- key=${row.candidateKey} | sourceKind=${row.sourceKind} | targetSkill=${row.targetSkill} | estMinutes=${row.estMinutes} | minMinutes=${row.minMinutes} | gap=${row.skillGapKey ?? 'none'}`,
    )
    .join('\n');
}

/** 多日预算块（`dailyBudgetBlock`）。 */
export function buildDailyBudgetBlock(
  days: readonly { date: string; minutes: number; isRestDay: boolean }[],
): string {
  if (days.length === 0) return '（无）';
  return days
    .slice(0, 30)
    .map((day) => `${day.date}：${day.isRestDay ? '休息日' : `${day.minutes} 分钟`}`)
    .join('；');
}

/** 缺口摘要块（`gapSummaryBlock`）。 */
export function buildGapSummaryBlock(gaps: readonly SkillGapDraft[]): string {
  if (gaps.length === 0) return '（无）';
  return gaps
    .slice(0, 20)
    .map(
      (gap) =>
        `- ${gap.dimensionKind}:${gap.skill}/${gap.subskill} kind=${gap.kind} severity=${gap.severity} reason=${truncate(gap.reason, 120)}`,
    )
    .join('\n');
}

/**
 * 润色任务理由。
 *
 * 它**只返回措辞**：调用方必须用 `assertReasonOnlyChanged()` 复核后再落 UI，
 * 不得把 AI 输出当作决策字段的来源。
 */
export async function polishExplanations(input: {
  prisma: PrismaClient;
  snapshotId: string;
  tasks: TaskExplanationSeed[];
  timeoutMs?: number;
}): Promise<
  | { ok: true; polished: Map<string, string>; callLogId: string | null }
  | AiPlannerFailure
> {
  const seeds = input.tasks.filter((task) => task.candidateKey.length > 0);
  if (seeds.length === 0) {
    return { ok: false, code: 'NO_TASKS', message: '没有需要润色的任务', callLogId: null };
  }

  const outcome = await runAiCompletion({
    prisma: input.prisma,
    promptKind: 'plan_explain',
    meta: {
      mode: 'PLAN',
      skill: 'INTEGRATED',
      objective: '润色计划任务理由',
      targetLevel: '',
      planDayBlock: buildPlanDayBlock(seeds),
    },
    temperature: 0.3,
    timeoutMs: input.timeoutMs,
    logMetadata: { snapshotId: input.snapshotId },
  });
  if (!outcome.ok) {
    return {
      ok: false,
      code: outcome.code,
      message: outcome.message,
      callLogId: outcome.logId ?? null,
    };
  }

  const allowed = new Set(seeds.map((task) => task.candidateKey));
  const data = outcome.structured as { tasks: { candidate_key: string; reason: string }[] };
  const polished = new Map<string, string>();
  for (const row of data.tasks) {
    if (!allowed.has(row.candidate_key)) continue;
    polished.set(row.candidate_key, row.reason);
  }
  return { ok: true, polished, callLogId: outcome.logId };
}

/**
 * 从候选池中挑选并排优先级。
 *
 * 池外 key 的拒绝不在这里做——那是 `resolveAiPicks()` 的职责（纯函数，可单测）；
 * 本函数只负责把 provider 输出变成 `{candidateKey, why, order}`。
 */
export async function suggestCandidateOrder(input: {
  prisma: PrismaClient;
  snapshotId: string;
  pool: TaskCandidateDraft[];
  budgetMinutes: number;
  maxPicks?: number;
  /** 未来几天的预算（`dailyBudgetBlock`）；不传则只有当日。 */
  dailyBudgets?: { date: string; minutes: number; isRestDay: boolean }[];
  timeoutMs?: number;
}): Promise<
  | {
      ok: true;
      picks: { candidateKey: string; why: string; order: number }[];
      callLogId: string | null;
    }
  | AiPlannerFailure
> {
  const maxPicks = Math.min(10, Math.max(1, input.maxPicks ?? 10));
  const outcome = await runAiCompletion({
    prisma: input.prisma,
    promptKind: 'plan_suggest_candidates',
    meta: {
      mode: 'PLAN',
      skill: 'INTEGRATED',
      objective: '从候选池中挑选优先候选',
      targetLevel: '',
      candidatePoolBlock: buildCandidatePoolBlock(input.pool),
      budgetMinutes: input.budgetMinutes,
      dailyBudgetBlock: buildDailyBudgetBlock(input.dailyBudgets ?? []),
    },
    temperature: 0.2,
    timeoutMs: input.timeoutMs,
    logMetadata: { snapshotId: input.snapshotId },
  });
  if (!outcome.ok) {
    return {
      ok: false,
      code: outcome.code,
      message: outcome.message,
      callLogId: outcome.logId ?? null,
    };
  }

  const data = outcome.structured as {
    picks: { candidate_key: string; why: string; suggested_order: number }[];
  };
  const picks = data.picks
    .slice(0, maxPicks)
    .map((row) => ({
      candidateKey: row.candidate_key,
      why: row.why,
      order: row.suggested_order,
    }));
  return { ok: true, picks, callLogId: outcome.logId };
}

/**
 * 建议下周 3 个主突破主题。
 *
 * 目前只作为规划域 AI 层的公开入口（周复盘页仍用确定性建议，见
 * `docs/47-v2.7-known-limits.md`）；`buildPlan` 不消费它，避免同一周出现两套主题。
 */
export async function suggestWeeklyTheme(input: {
  prisma: PrismaClient;
  snapshotId: string;
  metrics: WeeklyMetricDraft[];
  gaps: SkillGapDraft[];
  recentDelta?: WeeklyMetricDraft[];
  timeoutMs?: number;
}): Promise<
  | {
      ok: true;
      options: { theme: string; rationale: string; evidenceRefs: string[] }[];
      callLogId: string | null;
    }
  | AiPlannerFailure
> {
  const metricsBlock =
    input.metrics.length === 0
      ? '（无）'
      : input.metrics
          .slice(0, 20)
          .map((row) => `- ${row.label}：${row.value}${row.note ? `（${row.note}）` : ''}`)
          .join('\n');
  const deltaBlock =
    input.recentDelta && input.recentDelta.length > 0
      ? input.recentDelta
          .slice(0, 20)
          .map((row) => `- ${row.label}：${row.value}${row.note ? `（${row.note}）` : ''}`)
          .join('\n')
      : '（无）';

  const outcome = await runAiCompletion({
    prisma: input.prisma,
    promptKind: 'plan_weekly_theme',
    meta: {
      mode: 'PLAN',
      skill: 'INTEGRATED',
      objective: '建议下周主突破主题',
      targetLevel: '',
      weeklyMetricsBlock: metricsBlock,
      gapSummaryBlock: buildGapSummaryBlock(input.gaps),
      recentDeltaBlock: deltaBlock,
    },
    temperature: 0.5,
    timeoutMs: input.timeoutMs,
    logMetadata: { snapshotId: input.snapshotId },
  });
  if (!outcome.ok) {
    return {
      ok: false,
      code: outcome.code,
      message: outcome.message,
      callLogId: outcome.logId ?? null,
    };
  }

  const data = outcome.structured as {
    options: { theme: string; rationale: string; evidence_refs: string[] }[];
  };
  return {
    ok: true,
    options: data.options.map((row) => ({
      theme: row.theme,
      rationale: row.rationale,
      evidenceRefs: row.evidence_refs,
    })),
    callLogId: outcome.logId,
  };
}