/**
 * 多维词汇掌握 —— 纯函数（v2.3 Phase 4）。
 *
 * 七个维度独立推进，不合并成「已掌握」：
 * - TypeWords 会话只能推进识别/回忆/拼写/听音四个维度；
 * - 语境理解必须来自带语境的证据；
 * - 产出使用只接受 E4/E5 级证据（不能由选择题推断）。
 */

import {
  VOCAB_DIMENSIONS,
  VOCAB_DIMENSION_STATUSES,
  VOCAB_MODE_DIMENSIONS,
  type VocabDimension,
  type VocabDimensionStatus,
  type VocabPracticeMode,
} from '../constants';

export interface DimensionState {
  dimension: VocabDimension;
  status: VocabDimensionStatus;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  evidenceCount: number;
  lastVerifiedAt: string | null;
}

export interface AttemptOutcome {
  mode: VocabPracticeMode;
  result: 'CORRECT' | 'INCORRECT' | 'SKIPPED';
  /** 业务日期（YYYY-MM-DD）；用于判断是否「换天后再对一次」。 */
  businessDate: string;
  /** 该维度上一次正确日期；用于间隔判定。 */
  priorVerifiedDate?: string | null;
}

function statusIndex(status: VocabDimensionStatus): number {
  return VOCAB_DIMENSION_STATUSES.indexOf(status);
}

function maxStatus(a: VocabDimensionStatus, b: VocabDimensionStatus): VocabDimensionStatus {
  return statusIndex(a) >= statusIndex(b) ? a : b;
}

/** 每个维度允许推进到的封顶等级（产出使用不能由练习会话自动到达）。 */
const DIMENSION_CAP: Record<VocabDimension, VocabDimensionStatus> = {
  FORM_RECOGNITION: 'RECALLED',
  MEANING_RECOGNITION: 'RECALLED',
  MEANING_RECALL: 'RECALLED',
  SPELLING_RECALL: 'RECALLED',
  LISTENING_RECOGNITION: 'RECALLED',
  CONTEXT_UNDERSTANDING: 'CONTEXT_UNDERSTOOD',
  PRODUCTIVE_USE: 'PRODUCTIVE_USE_VERIFIED',
};

/**
 * 单次尝试对某维度的影响。
 *
 * 规则（显式、可测）：
 * - 答错 / 跳过：降到 INTRODUCED，置信度 LOW（但不回到 UNKNOWN —— 已接触过）；
 * - 答对且当天首次：最多到 INTRODUCED / RECOGNIZED（识别类维度直接 RECOGNIZED）；
 * - 答对且与上次正确不在同一天：推进一级（最多到该维度封顶）。
 */
export function advanceDimension(
  state: DimensionState,
  outcome: AttemptOutcome,
): DimensionState {
  const applies = VOCAB_MODE_DIMENSIONS[outcome.mode].includes(state.dimension);
  if (!applies) return state;

  if (outcome.result !== 'CORRECT') {
    if (state.status === 'UNKNOWN') {
      return {
        ...state,
        status: 'INTRODUCED',
        confidence: 'LOW',
        evidenceCount: state.evidenceCount + 1,
        lastVerifiedAt: state.lastVerifiedAt,
      };
    }
    return {
      ...state,
      status: 'INTRODUCED',
      confidence: 'LOW',
      evidenceCount: state.evidenceCount + 1,
      lastVerifiedAt: state.lastVerifiedAt,
    };
  }

  const priorDate = outcome.priorVerifiedDate ?? state.lastVerifiedAt;
  const repeatedSameDay = priorDate !== null && priorDate === outcome.businessDate;
  const currentIndex = Math.max(0, statusIndex(state.status));
  // 首次答对至少到「能识别」；换天后再对才推进一级；同一天重复对不虚增等级。
  const desiredIndex = repeatedSameDay
    ? Math.max(currentIndex, statusIndex('RECOGNIZED'))
    : Math.max(currentIndex + 1, statusIndex('RECOGNIZED'));
  const cappedIndex = Math.min(statusIndex(DIMENSION_CAP[state.dimension]), desiredIndex);
  const nextStatus = VOCAB_DIMENSION_STATUSES[Math.max(currentIndex, cappedIndex)];

  const evidenceCount = state.evidenceCount + 1;
  const confidence = evidenceCount >= 3 && statusIndex(nextStatus) >= statusIndex('RECALLED')
    ? 'HIGH'
    : evidenceCount >= 2
      ? 'MEDIUM'
      : 'LOW';

  return {
    dimension: state.dimension,
    status: nextStatus,
    confidence,
    evidenceCount,
    lastVerifiedAt: outcome.businessDate,
  };
}

/** 初始化七维状态（全部 UNKNOWN）。 */
export function emptyDimensionStates(): DimensionState[] {
  return VOCAB_DIMENSIONS.map((dimension) => ({
    dimension,
    status: 'UNKNOWN' as VocabDimensionStatus,
    confidence: 'LOW' as const,
    evidenceCount: 0,
    lastVerifiedAt: null,
  }));
}

/**
 * 证据级别能否推进维度。
 * E0/E1 只是接触；语境理解需要 E2 且带语境；产出使用需要 E4/E5。
 */
export function evidencePromotesDimension(
  dimension: VocabDimension,
  level: 'E0' | 'E1' | 'E2' | 'E3' | 'E4' | 'E5',
): boolean {
  const index = Number(level.slice(1));
  // 脏等级（如 'X'）的 slice 结果是 ''，Number('') === 0 会伪装成 E0；
  // 显式拦掉非有限值，避免「无法识别」被当成「最低一级」。
  if (!Number.isFinite(index)) return false;
  if (dimension === 'PRODUCTIVE_USE') return index >= 4;
  if (dimension === 'CONTEXT_UNDERSTANDING') return index >= 2;
  return index >= 1;
}

/** 证据级别 → 该维度可达到的最高状态（用于把证据写回维度）。 */
export function statusForEvidence(
  dimension: VocabDimension,
  level: 'E0' | 'E1' | 'E2' | 'E3' | 'E4' | 'E5',
): VocabDimensionStatus | null {
  if (!evidencePromotesDimension(dimension, level)) return null;
  if (dimension === 'PRODUCTIVE_USE') return 'PRODUCTIVE_USE_VERIFIED';
  if (dimension === 'CONTEXT_UNDERSTANDING') return 'CONTEXT_UNDERSTOOD';
  const index = Number(level.slice(1));
  if (!Number.isFinite(index)) return 'INTRODUCED';
  if (index >= 3) return 'RECALLED';
  if (index >= 1) return 'RECOGNIZED';
  return 'INTRODUCED';
}

/** 合并状态：只升不降（证据撤销走单独流程，不在这里静默降级）。 */
export function mergeStatus(
  current: VocabDimensionStatus,
  next: VocabDimensionStatus,
): VocabDimensionStatus {
  return maxStatus(current, next);
}

/**
 * 把 OS 的证据三元组换算成 E0–E5 的「强度等级」。
 *
 * 这是维度推进的唯一入口；UI 不自行解释等级。
 * 规则显式写死，避免「AI 觉得这条证据够 E4」式的运行时推断。
 */
export function toEvidenceGrade(input: {
  evidenceType: string;
  level: string;
  assistanceLevel: string;
}): 'E0' | 'E1' | 'E2' | 'E3' | 'E4' | 'E5' {
  if (input.assistanceLevel === 'A4') return 'E0';
  if (input.assistanceLevel === 'A3') return 'E1';

  switch (input.evidenceType) {
    case 'TRANSFER':
      return 'E5';
    case 'APPLIED_TASK':
      return input.assistanceLevel === 'A0' ? 'E4' : 'E3';
    case 'DELAYED_RETEST':
      return 'E3';
    case 'IMMEDIATE_RETEST':
      return 'E2';
    case 'BASELINE':
    case 'ASSISTED':
    default:
      return input.level === 'QUICK' ? 'E1' : 'E2';
  }
}
