/**
 * 材料状态机（`LearningMaterial.status`）——纯函数、无 IO，便于穷举单测。
 *
 * 规范性来源：`docs/31-v2.6-state-machine.mermaid`。与图的差异只有三处，
 * 都是架构 §5 明写的产品行为，图里漏画了边：
 * 1. `normalizing → partial`：chunk 数超过 800 时停切并落 partial（§5「单材料 chunk 数」）；
 * 2. 其余（`extracting → partial` 扫描页、`analyzing → partial` 调用上限等）与图一致；
 * 3. `review_required → generating`（T11）：练习生成**由用户点「生成练习」触发**，
 *    是人在待审核页主动发起的一次新运行，不是 tick 自己往前走。没有这条边，
 *    「分析已完成、但这份材料还没出过题」就永远补不上（tick 在 `review_required`
 *    明确停手，见 `pipeline.ts` 的 `awaiting_review`）。
 *
 * 为什么把表放在这里而不是散落在 tick 引擎里：状态转移是**最容易写错**的地方，
 * 集中成一张表 + `canTransition/assertTransition` 才能被单测覆盖「非法转移必须被拒」。
 */

import type { MaterialJobStage, MaterialStatus } from '@/lib/constants';

/** 合法转移表：`from → 允许的 to 集合`。 */
export const MATERIAL_TRANSITIONS: Record<MaterialStatus, readonly MaterialStatus[]> = {
  created: ['validating', 'cancelled'],
  validating: ['extracting', 'failed', 'cancelled'],
  extracting: ['normalizing', 'failed', 'partial', 'cancelled'],
  normalizing: ['analyzing', 'partial', 'failed', 'cancelled'],
  analyzing: ['generating', 'partial', 'failed', 'review_required', 'cancelled'],
  generating: ['review_required', 'partial', 'failed', 'cancelled'],
  // `review_required → generating`：用户点「生成练习」手动触发的一次新运行（T11）。
  // 刻意**不加** `review_required → ready` 以外的自动边：待审核之后的每一步都由人驱动。
  review_required: ['ready', 'partial', 'generating'],
  ready: [],
  // partial 是终态但可续跑（`partial → analyzing` 仅当还有未分析 chunk 且未超 AI 调用上限）
  partial: ['analyzing'],
  // 重试：failed → created，attempt+1，复用已解析 chunk（A-08）
  failed: ['created'],
  cancelled: [],
};

/** 终态：tick 不再推进。 */
export const MATERIAL_TERMINAL_STATUSES: readonly MaterialStatus[] = [
  'ready',
  'partial',
  'failed',
  'cancelled',
];

/** 状态 → 对应的处理阶段（`created` 属于 validating 阶段的入口）。 */
export const STATUS_TO_STAGE: Partial<Record<MaterialStatus, MaterialJobStage>> = {
  validating: 'validating',
  extracting: 'extracting',
  normalizing: 'normalizing',
  analyzing: 'analyzing',
  generating: 'generating',
};

/** 阶段 → 该阶段正常完成后应到达的状态。 */
export const STAGE_TO_STATUS: Record<MaterialJobStage, MaterialStatus> = {
  validating: 'extracting',
  extracting: 'normalizing',
  normalizing: 'analyzing',
  analyzing: 'generating',
  generating: 'review_required',
};

/** 是否合法转移。 */
export function canTransition(from: MaterialStatus, to: MaterialStatus): boolean {
  return (MATERIAL_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 断言合法转移；非法时抛错（调用方只用于「程序性错误」自检，
 * 用户可见错误一律用返回值表达）。
 */
export function assertTransition(from: MaterialStatus, to: MaterialStatus): void {
  if (!canTransition(from, to)) {
    const allowed = (MATERIAL_TRANSITIONS[from] ?? []).join(' / ') || '（无）';
    throw new Error(`非法状态转移：${from} → ${to}（允许：${allowed}）`);
  }
}

/** 是否终态（不再自动推进）。 */
export function isTerminal(status: MaterialStatus): boolean {
  return MATERIAL_TERMINAL_STATUSES.includes(status);
}

/** 是否可取消（状态机里存在 → cancelled 的边）。 */
export function isCancellable(status: MaterialStatus): boolean {
  return canTransition(status, 'cancelled');
}

/** 是否可重试（只有 failed 可重试，A-08）。 */
export function isRetryable(status: MaterialStatus): boolean {
  return status === 'failed';
}

/** 处理中的状态集合（`created` 也算，因为首个 tick 就要跑校验）。 */
const PROCESSING_STATUSES = new Set<MaterialStatus>([
  'created',
  'validating',
  'extracting',
  'normalizing',
  'analyzing',
  'generating',
]);

/** 状态是否处于「处理中」（UI 需要轮询）。 */
export function isProcessingStatus(status: MaterialStatus): boolean {
  return PROCESSING_STATUSES.has(status);
}

/**
 * 取「下一个阶段」。
 *
 * `review_required` 之后没有阶段（等用户裁决），返回 null。
 */
export function nextStage(stage: MaterialJobStage): MaterialJobStage | null {
  const order = ['validating', 'extracting', 'normalizing', 'analyzing', 'generating'] as const;
  const index = order.indexOf(stage);
  if (index < 0 || index === order.length - 1) return null;
  return order[index + 1];
}
