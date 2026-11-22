/**
 * 会话状态机与教学顺序守卫。
 *
 * 纯函数，不访问数据库；Actions 在写库前调用这里的守卫，
 * 保证「先基线、后提示」不被任何入口绕过。
 */

import { AI_HINT_MAX_LEVEL, type AiSessionStatus } from '@/lib/constants';
import type { HintResult } from './structured';

export const AI_STATUS_TRANSITIONS: Record<AiSessionStatus, readonly AiSessionStatus[]> = {
  CREATED: ['TASK_PRESENTED', 'CANCELLED', 'FAILED'],
  TASK_PRESENTED: ['BASELINE_SUBMITTED', 'PAUSED', 'CANCELLED'],
  BASELINE_SUBMITTED: ['DIAGNOSING', 'CANCELLED'],
  DIAGNOSING: ['FEEDBACK_READY', 'FAILED'],
  FEEDBACK_READY: [
    'HINTING',
    'TEACHING',
    'PRACTICE',
    'IMMEDIATE_RETEST',
    'COMPLETED',
    'PAUSED',
    'CANCELLED',
  ],
  HINTING: ['HINTING', 'TEACHING', 'PRACTICE', 'FEEDBACK_READY', 'PAUSED', 'CANCELLED'],
  TEACHING: ['PRACTICE', 'IMMEDIATE_RETEST', 'PAUSED', 'CANCELLED'],
  PRACTICE: ['IMMEDIATE_RETEST', 'HINTING', 'PAUSED', 'CANCELLED'],
  IMMEDIATE_RETEST: ['COMPLETED', 'PRACTICE', 'CANCELLED'],
  COMPLETED: ['DELAYED_RETEST_SCHEDULED'],
  DELAYED_RETEST_SCHEDULED: [],
  PAUSED: [
    'TASK_PRESENTED',
    'FEEDBACK_READY',
    'HINTING',
    'PRACTICE',
    'IMMEDIATE_RETEST',
    'CANCELLED',
  ],
  CANCELLED: [],
  FAILED: [],
};

export const AI_TERMINAL_STATUSES: readonly AiSessionStatus[] = [
  'COMPLETED',
  'DELAYED_RETEST_SCHEDULED',
  'CANCELLED',
  'FAILED',
];

export function canTransition(from: AiSessionStatus, to: AiSessionStatus): boolean {
  return AI_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: AiSessionStatus): boolean {
  return AI_TERMINAL_STATUSES.includes(status);
}

export interface SessionGuardState {
  status: AiSessionStatus;
  baselineText: string | null;
  directTeaching: boolean;
}

export function hasBaseline(state: Pick<SessionGuardState, 'baselineText'>): boolean {
  return (state.baselineText ?? '').trim().length > 0;
}

const HINT_CAPABLE: readonly AiSessionStatus[] = [
  'FEEDBACK_READY',
  'HINTING',
  'PRACTICE',
];

/**
 * 提示/讲解/练习的前置条件：基线必须已保存。
 * 会话暂停、取消或尚未看到反馈时一律拒绝。
 */
export function canRequestSupport(state: SessionGuardState): boolean {
  if (!hasBaseline(state)) return false;
  return HINT_CAPABLE.includes(state.status);
}

/** 下一次允许请求的提示级别：只能逐级 +1，上限 3。 */
export function nextAllowedHintLevel(maxUsedLevel: number): number {
  return Math.min(AI_HINT_MAX_LEVEL, Math.max(0, maxUsedLevel) + 1);
}

export function validateHintRequest(
  maxUsedLevel: number,
  requestedLevel: number,
): { ok: true; level: number } | { ok: false; message: string } {
  if (!Number.isInteger(requestedLevel) || requestedLevel < 1) {
    return { ok: false, message: '提示级别必须是 1–3 的整数' };
  }
  if (requestedLevel > AI_HINT_MAX_LEVEL) {
    return { ok: false, message: `提示最多 ${AI_HINT_MAX_LEVEL} 级` };
  }
  const allowed = nextAllowedHintLevel(maxUsedLevel);
  if (requestedLevel > allowed) {
    return { ok: false, message: `请先使用第 ${allowed} 级提示，不允许跳级` };
  }
  return { ok: true, level: requestedLevel };
}

/** 1–2 级提示不得泄露答案（schema 已校验，这里是业务侧二次防线）。 */
export function hintLeaksAnswer(hint: HintResult): boolean {
  return hint.hint_level < AI_HINT_MAX_LEVEL && hint.reveals_answer;
}

/** 复测与延迟复测只能在反馈就绪之后发起。 */
export function canStartRetest(status: AiSessionStatus): boolean {
  return status === 'FEEDBACK_READY' || status === 'PRACTICE' || status === 'TEACHING';
}

export function canScheduleDelayedRetest(status: AiSessionStatus): boolean {
  return status === 'COMPLETED' || status === 'DELAYED_RETEST_SCHEDULED';
}