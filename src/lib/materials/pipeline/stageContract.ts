/**
 * 阶段处理器的统一契约（tick 引擎与 3 个阶段共用，避免循环依赖）。
 *
 * 约定：阶段处理器**只做一件事**（一个工作单元），把「应该变成什么状态、
 * 计数是多少、失败码是什么」作为数据返回；真正的落库与 lockVersion 乐观锁
 * 由 `pipeline.ts` 统一施加 —— 这样阶段内部没有任何并发控制代码，
 * 也就不会出现两个阶段各自实现一套锁的漂移。
 */

import type {
  MaterialFormat,
  MaterialJobStatus,
  MaterialJobStage,
  MaterialStatus,
  MaterialSourceType,
} from '@/lib/constants';
import type { ParseResult } from '@/lib/materials/parsers/types';

/** 进度（写入 `ProcessingJob.progressJson`）。 */
export interface StageProgress {
  done: number;
  total: number;
  unitLabel: string;
  /**
   * 回验未通过、被丢弃的条数（`dropped_unverifiable`，ADR-04 L4）。
   *
   * 放在进度里而不是 `PartialDetail`：材料**正常跑完**也可能丢几条，而
   * `PartialDetail` 只在 `partial` 状态才写，会把这条信息丢掉。
   */
  droppedUnverifiable?: number;
  /**
   * 本阶段额外跳过的单元数（目前只有 `generating` 用）。
   *
   * `generating` 的续跑判据是「这些 chunk 已经出过题」：第二个 tick 上
   * `done === total` 却一道新题都没生成。只报「批次 4 / 4」会让界面出现
   * 「批次 4/4、已生成 0 道」这种自相矛盾的组合，所以要把跳过数单独说出来。
   */
  skipped?: number;
}

/** 一个 tick 内消耗的 AI 计量（由 pipeline 累加进 `ProcessingJob`）。 */
export interface StageAiUsage {
  /** 本 tick 的 AI 调用次数。 */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/** 空的计量累加器（`analyzing` / `generating` 共用一个实现，避免两份漂移）。 */
export function emptyAiUsage(): StageAiUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

/** 把一个计量累加进另一个（原地修改 `target`）。 */
export function addAiUsage(target: StageAiUsage, add: StageAiUsage): void {
  target.calls += add.calls;
  target.inputTokens += add.inputTokens;
  target.outputTokens += add.outputTokens;
  target.estimatedCostUsd += add.estimatedCostUsd;
}

/**
 * AI 失败码 → 材料错误码（架构 §6.4 只允许固定映射表里的值）。
 *
 * 放在契约层而不是各阶段里：两个阶段的映射必须一致，否则同一类 AI 失败
 * 在分析阶段报 `SCHEMA_VALIDATION`、在出题阶段报别的码，排查时会以为是两个问题。
 */
export function materialErrorCodeOf(code: string): string {
  if (code === 'BUDGET_EXCEEDED') return 'BUDGET_EXCEEDED';
  if (code === 'TIMEOUT') return 'PARSE_TIMEOUT';
  if (code === 'INVALID_OUTPUT') return 'SCHEMA_VALIDATION';
  if (code === 'PRECONDITION') return 'SCHEMA_VALIDATION';
  return 'INTERNAL_STORAGE';
}

/** 部分完成的明细（US-8 / A-06）。 */
export interface PartialDetail {
  /** 无可提取文本层的页码（PDF 扫描页）。 */
  pages: number[];
  /** 丢弃元素计数（图片/脚注/批注/HTML 节点…）。 */
  droppedElements: Record<string, number>;
  /** 是否因 AI 调用上限停下（T09 才会置 true，本批恒 false）。 */
  aiCallLimitHit: boolean;
}

/** 阶段产出的材料计数（一次写全，避免多次 update）。 */
export interface MaterialCounts {
  charCount?: number;
  wordCount?: number;
  pageCount?: number | null;
  chunkCount?: number;
  estimatedMinutes?: number | null;
}

/** 阶段执行结果。 */
export interface StageOutcome {
  /** 目标状态（必须是状态机里的合法边）。 */
  to: MaterialStatus;
  /** 目标阶段（写入 `ProcessingJob.stage`）。 */
  stage: MaterialJobStage;
  progress: StageProgress;
  /** 面向用户的降级/失败原因（人话，不含路径与原文）。 */
  statusReason?: string | null;
  /** 失败时的机器码（取自 `MATERIAL_ERROR_CODES`）。 */
  error?: { code: string; message: string };
  counts?: MaterialCounts;
  partial?: PartialDetail;
  /** job 终态；缺省由 `to` 推导（failed/cancelled → 对应终态，其余 → running）。 */
  jobStatus?: MaterialJobStatus;
  /** 本 tick 的 AI 计量（只有 `analyzing`/`generating` 会填）。 */
  aiUsage?: StageAiUsage;
  /** 本 tick 是否真的做了工作（DTO 的 advanced 用它）。 */
  didWork?: boolean;
}

/** 阶段需要的材料快照（只读）。 */
export interface StageMaterial {
  id: string;
  title: string;
  format: MaterialFormat;
  status: MaterialStatus;
  language: string;
  sourceType: MaterialSourceType;
}

/** 阶段需要的任务快照（只读；写库一律由 pipeline 负责）。 */
export interface StageJob {
  id: string;
  attempt: number;
  stage: string;
  status: string;
  lockVersion: number;
  cancelRequested: boolean;
  /** 已累计的 AI 调用次数（材料级预算闸门用它，A-08 重试后继续累计）。 */
  aiCallCount: number;
  /** 已累计的输入 token（材料级 260k 上限用它）。 */
  inputTokens: number;
  /** 已累计的输出 token。 */
  outputTokens: number;
  /** 已累计的估算成本（USD）。 */
  estimatedCostUsd: number;
  progress: StageProgress;
  /** 各阶段耗时（毫秒），用于时间线展示。 */
  msByStage: Record<string, number>;
}

export interface StageContext {
  material: StageMaterial;
  job: StageJob;
  /** 本 tick 的截止时刻（`Date.now() + tickBudgetMs`）。 */
  deadline: number;
  /** 在下一个 await 边界重新读库判断是否已请求取消。 */
  isCancelled: () => Promise<boolean>;
}

export type StageHandler = (ctx: StageContext) => Promise<StageOutcome>;

/** 失败结果的构造器（统一走 `MATERIAL_ERROR_MESSAGES_ZH` 文案）。 */
export function stageFailure(
  stage: MaterialJobStage,
  code: string,
  message: string,
  counts?: MaterialCounts,
): StageOutcome {
  return {
    to: 'failed',
    stage,
    progress: { done: 0, total: 1, unitLabel: '项' },
    statusReason: message,
    error: { code, message },
    jobStatus: 'failed',
    counts,
    didWork: true,
  };
}

/** 取消结果的构造器。 */
export function stageCancelled(ctx: StageContext, reason = '已按你的要求取消处理'): StageOutcome {
  return {
    to: 'cancelled',
    stage: (ctx.job.stage as MaterialJobStage) ?? 'validating',
    progress: ctx.job.progress,
    statusReason: reason,
    error: { code: 'CANCELLED', message: reason },
    jobStatus: 'cancelled',
    didWork: false,
  };
}

/** 解析快照（`MaterialAsset(kind='PARSED_JSON')` 的内容）。 */
export interface ParsedSnapshot {
  parserName: string;
  parserVersion: string;
  parsed: ParseResult;
}

/** 解析快照的派生文件名（落在 `materials/{id}/` 下）。 */
export const PARSED_SNAPSHOT_FILE = 'parsed.json';
