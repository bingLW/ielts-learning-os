/**
 * tick 引擎（ADR-05）：单机串行推进材料处理任务。
 *
 * 设计要点（逐条对应 ADR-05 与状态机）：
 * 1. **一次 tick 只推进一个阶段的一个工作单元**。没有队列中间件、没有后台进程，
 *    客户端每 3s POST 一次 `/api/materials/[id]/tick` 就是在「驱动状态机」。
 * 2. **单机串行**：`ProcessingJob.lockVersion` 乐观锁。更新时 `where: { id, lockVersion }`，
 *    `updateMany` 返回 0 行即视为并发冲突 —— 直接返回当前状态，**不报错**（另一个
 *    tick 已经在推进了，报错只会污染日志与 UI）。
 * 3. **取消不强杀进程**：`cancelRequested=true` 时在下一个 await 边界把两个表都置
 *    `cancelled`，让正在跑的分块自然结束（A-07）。
 * 4. **预算**：整次 tick 超过 `tickBudgetMs` 就返回，下次 tick 续（阶段内部只做单工作单元，
 *    真正吃时间的是 pdfjs 与 AI 调用）。
 * 5. **未接入的阶段**：`analyzing` 由 T09 注册、`generating` 由 T10 注册**占位实现**
 *    （T11 替换成真实生成器）。若将来再出现没有处理器的阶段，这里会走一条合法的
 *    `<stage> → review_required`，把材料停在待审核并写清原因，**不报错**。
 */

import {
  MATERIAL_JOB_STAGE_LABELS_ZH,
  MATERIAL_LIMITS,
  type MaterialFormat,
  type MaterialJobStage,
  type MaterialSourceType,
  type MaterialStatus,
} from '@/lib/constants';
import { parseJson, stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, ok } from '@/lib/result';
import type { ActionResult } from '@/lib/types';
import {
  assertTransition,
  canTransition,
  isTerminal,
  STAGE_TO_STATUS,
  STATUS_TO_STAGE,
} from './stateMachine';
import type {
  StageContext,
  StageHandler,
  StageJob,
  StageOutcome,
  StageProgress,
} from './pipeline/stageContract';
import { analyzingStage } from './pipeline/stages/analyzing';
import { extractingStage } from './pipeline/stages/extracting';
import { generatingStage } from './pipeline/stages/generating';
import { normalizingStage } from './pipeline/stages/normalizing';
import { validatingStage } from './pipeline/stages/validating';

/**
 * 已注册的阶段处理器。
 *
 * T09 注册了 `analyzing`（AI 抽取）；T10 注册了 `generating` 的**占位实现**
 * （把材料交到 `review_required`），T11 用真实生成器替换 `stages/generating.ts`。
 * **只在这里追加**，其余代码（route、query、UI）不需要改。
 */
export const STAGE_HANDLERS: Partial<Record<MaterialJobStage, StageHandler>> = {
  validating: validatingStage,
  extracting: extractingStage,
  normalizing: normalizingStage,
  analyzing: analyzingStage,
  generating: generatingStage,
};

/** `progressJson` 的实际结构（比 DTO 多一个 `msByStage`）。 */
interface JobProgress {
  stage?: string;
  done?: number;
  total?: number;
  unitLabel?: string;
  droppedUnverifiable?: number;
  msByStage?: Record<string, number>;
}

export interface PipelineTickResult {
  materialId: string;
  status: MaterialStatus;
  stage: MaterialJobStage | null;
  /** 本 tick 是否真的推进了状态 */
  advanced: boolean;
  /** 未推进的原因（便于排查与测试断言） */
  reason:
    | 'advanced'
    | 'terminal'
    | 'awaiting_review'
    | 'stage_not_registered'
    | 'lock_conflict'
    | 'budget_exhausted'
    | 'cancelled'
    | 'illegal_transition'
    | 'no_job';
}

/** 并发冲突的内部信号（用于回滚整个事务）。 */
class LockConflictError extends Error {}

/**
 * 材料处于 `created` 时，「当前处在哪个状态」由 `ProcessingJob.stage` 决定。
 *
 * 平时材料从 `created` 起步、job 在 `validating`，两者一致；但**重试是从中途续跑**的
 * （A-08：已有 `ParsedDocument` 时跳过 `extracting`，job 直接落在 `normalizing`），
 * 此时材料状态按规格回到 `created`，job 却已经站在后面某个阶段上。若仍按 `created`
 * 等价于 `validating` 去查转移表，`normalizing → analyzing` 这条合法边会被误判成非法，
 * 重试就永远推不动。所以这里以 `job.stage` 为恢复点的权威来源。
 */
const STAGE_ENTRY_STATUS: Record<MaterialJobStage, MaterialStatus> = {
  validating: 'validating',
  extracting: 'extracting',
  normalizing: 'normalizing',
  analyzing: 'analyzing',
  generating: 'generating',
};

function readProgress(raw: string | null): StageProgress {
  const parsed = parseJson<JobProgress>(raw, {}) ?? {};
  return {
    done: typeof parsed.done === 'number' && parsed.done >= 0 ? parsed.done : 0,
    total: typeof parsed.total === 'number' && parsed.total >= 0 ? parsed.total : 1,
    unitLabel: typeof parsed.unitLabel === 'string' && parsed.unitLabel ? parsed.unitLabel : '项',
    ...(typeof parsed.droppedUnverifiable === 'number' && parsed.droppedUnverifiable >= 0
      ? { droppedUnverifiable: parsed.droppedUnverifiable }
      : {}),
  };
}

function readMsByStage(raw: string | null): Record<string, number> {
  const parsed = parseJson<JobProgress>(raw, {}) ?? {};
  const entries = parsed.msByStage ?? {};
  const safe: Record<string, number> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = value;
  }
  return safe;
}

/** 由目标状态推导 job 终态。 */
function jobStatusOf(outcome: StageOutcome): string {
  if (outcome.jobStatus) return outcome.jobStatus;
  if (outcome.to === 'failed') return 'failed';
  if (outcome.to === 'cancelled') return 'cancelled';
  if (outcome.to === 'ready' || outcome.to === 'partial') return 'succeeded';
  return 'running';
}

/**
 * 推进一次。非终态材料的每次调用都会「尝试」做一点工作。
 *
 * @param materialId 目标材料
 */
export async function runPipelineTick(materialId: string): Promise<ActionResult<PipelineTickResult>> {
  const startedAt = Date.now();
  const deadline = startedAt + MATERIAL_LIMITS.tickBudgetMs;

  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: {
      id: true,
      title: true,
      format: true,
      status: true,
      language: true,
      sourceType: true,
    },
  });
  if (!material) return fail<PipelineTickResult>('NOT_FOUND', '材料不存在');

  const status = material.status as MaterialStatus;
  if (isTerminal(status)) {
    return ok<PipelineTickResult>({
      materialId,
      status,
      stage: STATUS_TO_STAGE[status] ?? null,
      advanced: false,
      reason: 'terminal',
    });
  }

  // `review_required` 是「等你裁决」的停靠站：往前的每一步都由用户的审核 action 驱动，
  // tick 不应该再跑阶段处理器（否则占位/真实阶段会被反复执行，白写库也白花钱）。
  if (status === 'review_required') {
    return ok<PipelineTickResult>({
      materialId,
      status,
      // 待审核没有「正在跑的阶段」：状态 → 阶段的映射表里本来就没有这一项
      stage: null,
      advanced: false,
      reason: 'awaiting_review',
    });
  }

  const jobRow = await prisma.processingJob.findFirst({
    where: { materialId },
    orderBy: { startedAt: 'desc' },
  });
  if (!jobRow) {
    return ok<PipelineTickResult>({
      materialId,
      status,
      stage: null,
      advanced: false,
      reason: 'no_job',
    });
  }

  const job: StageJob = {
    id: jobRow.id,
    attempt: jobRow.attempt,
    stage: jobRow.stage,
    status: jobRow.status,
    lockVersion: jobRow.lockVersion,
    cancelRequested: jobRow.cancelRequested,
    aiCallCount: jobRow.aiCallCount,
    inputTokens: jobRow.inputTokens,
    outputTokens: jobRow.outputTokens,
    estimatedCostUsd: jobRow.estimatedCostUsd,
    progress: readProgress(jobRow.progressJson),
    msByStage: readMsByStage(jobRow.progressJson),
  };

  // ── 取消收敛（A-07）：不强杀，只在 await 边界收敛 ────────────────────
  if (job.cancelRequested) {
    const applied = await applyOutcome(material.id, job, {
      to: 'cancelled',
      stage: (job.stage as MaterialJobStage) ?? 'validating',
      progress: job.progress,
      statusReason: '已按你的要求取消处理',
      error: { code: 'CANCELLED', message: '已按你的要求取消处理' },
      jobStatus: 'cancelled',
      didWork: false,
    });
    return ok<PipelineTickResult>({
      materialId,
      status: applied === 'applied' ? 'cancelled' : status,
      stage: (job.stage as MaterialJobStage) ?? null,
      advanced: applied === 'applied',
      reason:
        applied === 'applied' ? 'cancelled' : applied === 'conflict' ? 'lock_conflict' : 'illegal_transition',
    });
  }

  // ── 找当前阶段的处理器 ─────────────────────────────────────────────
  const stage = (job.stage || 'validating') as MaterialJobStage;
  const handler = STAGE_HANDLERS[stage];
  if (!handler) {
    return ok<PipelineTickResult>({
      materialId,
      status,
      stage,
      advanced: false,
      reason: 'stage_not_registered',
    });
  }

  if (Date.now() > deadline) {
    return ok<PipelineTickResult>({
      materialId,
      status,
      stage,
      advanced: false,
      reason: 'budget_exhausted',
    });
  }

  const ctx: StageContext = {
    material: {
      id: material.id,
      title: material.title,
      format: material.format as MaterialFormat,
      status,
      language: material.language,
      sourceType: material.sourceType as MaterialSourceType,
    },
    job,
    deadline,
    isCancelled: async () => {
      const fresh = await prisma.processingJob.findUnique({
        where: { id: job.id },
        select: { cancelRequested: true },
      });
      return fresh?.cancelRequested === true;
    },
  };

  const outcome = await handler(ctx);
  const applied = await applyOutcome(material.id, job, outcome, startedAt);

  if (applied !== 'applied') {
    return ok<PipelineTickResult>({
      materialId,
      status,
      stage,
      advanced: false,
      reason: applied === 'conflict' ? 'lock_conflict' : 'illegal_transition',
    });
  }

  if (outcome.to === 'cancelled') {
    return ok<PipelineTickResult>({
      materialId,
      status: 'cancelled',
      stage: outcome.stage,
      advanced: true,
      reason: 'cancelled',
    });
  }

  // ── 下一阶段未注册 → 合法地停在 review_required ──────────────────────
  // T08 只有 3 个阶段时停在 `analyzing` 之后；T09 注册了 `analyzing`，于是这里
  // 自然前移到 `generating`（T11 才接入），注册表加一行就自动生效。
  const upNext = STATUS_TO_STAGE[outcome.to];
  if (upNext && !STAGE_HANDLERS[upNext]) {
    await stallAtReviewRequired(material.id, outcome.to);
    return ok<PipelineTickResult>({
      materialId,
      status: 'review_required',
      stage: upNext,
      advanced: true,
      reason: 'stage_not_registered',
    });
  }

  return ok<PipelineTickResult>({
    materialId,
    status: outcome.to,
    stage: outcome.stage,
    advanced: true,
    reason: 'advanced',
  });
}

/**
 * 施加一次状态转移（含 lockVersion 乐观锁）。
 *
 * @returns `'applied'` 成功；`'conflict'` 并发冲突（另一个 tick 已推进）；
 *          `'illegal'` 状态与目标不构成合法边（说明别处已改了状态，放弃本次结果）
 */
async function applyOutcome(
  materialId: string,
  job: StageJob,
  outcome: StageOutcome,
  startedAt = Date.now(),
): Promise<'applied' | 'conflict' | 'illegal'> {
  const current = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { status: true },
  });
  if (!current) return 'illegal';

  const fromStatus = current.status as MaterialStatus;
  // `created` 表示「等待（重新）开始」，真正的起点看 job.stage（重试可从中途续跑）；
  // 同一状态重复施加按幂等处理（并发 tick 的败者靠后面的 lockVersion 兜住）
  const normalizedFrom =
    fromStatus === 'created'
      ? STAGE_ENTRY_STATUS[(job.stage || 'validating') as MaterialJobStage] ?? 'validating'
      : fromStatus;
  if (normalizedFrom !== outcome.to && !canTransition(normalizedFrom, outcome.to)) {
    return 'illegal';
  }

  const elapsed = Math.max(0, Date.now() - startedAt);
  const msByStage = { ...job.msByStage, [job.stage]: (job.msByStage[job.stage] ?? 0) + elapsed };
  const progressJson = stringify({
    stage: outcome.stage,
    done: outcome.progress.done,
    total: outcome.progress.total,
    unitLabel: outcome.progress.unitLabel || MATERIAL_JOB_STAGE_LABELS_ZH[outcome.stage],
    msByStage,
    ...(outcome.progress.droppedUnverifiable !== undefined
      ? { droppedUnverifiable: outcome.progress.droppedUnverifiable }
      : {}),
    // T12 §7.1：`generating` 的跳过数。`done === total` 但产出 0 时，
    // 没有这个数字，界面上就只剩一句自相矛盾的「批次 4 / 4 · 已生成 0 道」。
    ...(outcome.progress.skipped !== undefined && outcome.progress.skipped > 0
      ? { skipped: outcome.progress.skipped }
      : {}),
  });

  const jobStatus = jobStatusOf(outcome);
  const finished = jobStatus !== 'running';
  // AI 计量只在阶段真的调过模型时出现；`increment` 保证重试续跑时是从旧值继续累加
  const aiUsage = outcome.aiUsage;

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.processingJob.updateMany({
        where: { id: job.id, lockVersion: job.lockVersion },
        data: {
          stage: outcome.stage,
          status: jobStatus,
          progressJson,
          lastTickAt: new Date(),
          lockVersion: { increment: 1 },
          errorCode: outcome.error?.code ?? null,
          errorMessage: outcome.error?.message ?? null,
          ...(finished ? { finishedAt: new Date() } : {}),
          ...(aiUsage
            ? {
                aiCallCount: { increment: aiUsage.calls },
                inputTokens: { increment: aiUsage.inputTokens },
                outputTokens: { increment: aiUsage.outputTokens },
                estimatedCostUsd: { increment: aiUsage.estimatedCostUsd },
              }
            : {}),
        },
      });
      if (updated.count === 0) throw new LockConflictError();

      await tx.learningMaterial.update({
        where: { id: materialId },
        data: {
          status: outcome.to,
          statusReason: outcome.statusReason ?? null,
          ...(outcome.counts ?? {}),
          // 材料级**累计**用量（跨运行相加，Q5 成本可见性）：
          // job 上的计数器每次运行归零，「这份材料一共花了多少」只能看这里。
          ...(aiUsage
            ? {
                aiCallCount: { increment: aiUsage.calls },
                inputTokens: { increment: aiUsage.inputTokens },
                outputTokens: { increment: aiUsage.outputTokens },
                estimatedCostUsd: { increment: aiUsage.estimatedCostUsd },
              }
            : {}),
        },
      });
    });
    return 'applied';
  } catch (error) {
    if (error instanceof LockConflictError) return 'conflict';
    throw error;
  }
}

/**
 * 停放点：下一阶段（`generating`，T11 接入）还没有处理器。
 *
 * 这里再走一条**状态机里本来就合法**的 `analyzing|generating → review_required`，
 * 让材料停在「等你审核」，而不是报错或者卡在中间态。
 *
 * @param materialId 材料 id
 * @param fromStatus 当前实际状态（必须是 `review_required` 的合法前驱）
 */
async function stallAtReviewRequired(
  materialId: string,
  fromStatus: MaterialStatus,
): Promise<void> {
  assertTransition(fromStatus, 'review_required');
  const reason =
    fromStatus === 'generating'
      ? 'AI 分析完成，等待生成练习'
      : fromStatus === 'analyzing'
        ? '解析完成，等待 AI 分析'
        : '处理完成，等待你审核';
  await prisma.learningMaterial.updateMany({
    where: { id: materialId, status: fromStatus },
    data: { status: 'review_required', statusReason: reason },
  });
}

/** `STAGE_TO_STATUS` 的再导出，供 queries 复用（避免两处各写一份阶段→状态映射）。 */
export { STAGE_TO_STATUS };
