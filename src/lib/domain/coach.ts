/**
 * AI Learning Coach 协议与 AI 使用统计（纯函数）。
 *
 * 原则：
 * - Attempt First：第 1 步不允许用 AI，必须先留下 A0 尝试。
 * - A4（代写/代答）永远不算独立产出。
 * - 「改写/生成」至少按 A3 记录，不能伪装成 A0 学习成果。
 */

import { AI_A4_DEPENDENCY_WARN_PERCENT, COACH_STEPS } from '../constants';
import type { AIActionType, AdoptionStatus, AssistanceLevel, CoachStep } from '../types';

export function coachStepIndex(step: CoachStep): number {
  return COACH_STEPS.indexOf(step);
}

export function nextCoachStep(step: CoachStep): CoachStep | null {
  const index = coachStepIndex(step);
  return index >= 0 && index < COACH_STEPS.length - 1 ? COACH_STEPS[index + 1] : null;
}

export function previousCoachStep(step: CoachStep): CoachStep | null {
  const index = coachStepIndex(step);
  return index > 0 ? COACH_STEPS[index - 1] : null;
}

/** AI 只能在「先自己尝试」之后介入。 */
export function canUseAiAtStep(step: CoachStep): { ok: true } | { ok: false; error: string } {
  if (step === 'ATTEMPT') {
    return { ok: false, error: '先用自己写/说完成一次尝试并保存 A0 证据，再请求 AI。' };
  }
  return { ok: true };
}

const MACHINE_WRITTEN_ACTIONS: AIActionType[] = ['REWRITE', 'GENERATE'];

/** 改写/生成属于机器产出，至少按 A3 记录；A0–A2 不成立。 */
export function aiLevelAllowedForAction(
  level: AssistanceLevel,
  actionType: AIActionType,
): { ok: true } | { ok: false; error: string } {
  if (!MACHINE_WRITTEN_ACTIONS.includes(actionType)) return { ok: true };
  if (level === 'A3' || level === 'A4') return { ok: true };
  return {
    ok: false,
    error: '「改写/生成」是机器产出，至少要按 A3 记录；不能标成 A0–A2。',
  };
}

/** 独立产出只认 A0；A4 永远不算，其他级别也不算。 */
export function aiUsageIndependent(
  level: AssistanceLevel,
  _actionType: AIActionType,
): boolean {
  return level === 'A0';
}

export interface AiUsageLike {
  assistanceLevel: AssistanceLevel;
  actionType: AIActionType;
  adoptedOrRejected: AdoptionStatus;
}

export interface AiUsageStats {
  total: number;
  a4Count: number;
  /** 百分比，保留 1 位小数。 */
  a4Share: number;
  adoptedCount: number;
  rejectedCount: number;
  independentCount: number;
}

export function summarizeAiUsage(rows: readonly AiUsageLike[]): AiUsageStats {
  const total = rows.length;
  const a4Count = rows.filter((row) => row.assistanceLevel === 'A4').length;
  return {
    total,
    a4Count,
    a4Share: total === 0 ? 0 : Math.round((a4Count / total) * 1000) / 10,
    adoptedCount: rows.filter((row) => row.adoptedOrRejected === 'ADOPTED').length,
    rejectedCount: rows.filter((row) => row.adoptedOrRejected === 'REJECTED').length,
    independentCount: rows.filter((row) => aiUsageIndependent(row.assistanceLevel, row.actionType))
      .length,
  };
}

/** A4 依赖超过阈值时提醒，而不是等学习者自己发现。 */
export function a4DependencyWarning(sharePercent: number): boolean {
  return sharePercent > AI_A4_DEPENDENCY_WARN_PERCENT;
}
