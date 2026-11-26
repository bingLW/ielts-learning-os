import { parseTaskEstimate } from './taskEstimate';
import type { TaskEstimate } from '../types';
import type { TaskCandidateDraft } from './taskCandidate';

/** PlanTask.decisionJson 的兼容读形状；旧版本允许缺少任何新增字段。 */
export interface PersistedTaskDecision {
  candidateKey?: string | null;
  factors?: Record<string, number> | null;
  score?: number | null;
  priority?: string | null;
  rationale?: string | null;
  reason?: string | null;
  weightsVersion?: string | null;
  goalRef?: string | null;
  gapRef?: { skillGapKey: string; evidenceRefs: string[] } | null;
  estMinutes?: number | null;
  minMinutes?: number | null;
  prerequisites?: { text: string; met: boolean }[] | null;
  expectedOutput?: string | null;
  consequenceIfSkipped?: string | null;
  origin?: 'RULE' | 'AI' | 'USER_EDIT';
  wordingSource?: 'TEMPLATE' | 'AI_POLISHED';
  estimate?: TaskEstimate | null;
  candidateMeta?: TaskCandidateDraft['meta'] | null;
}

export function parseTaskDecisionJson(raw: string | null | undefined): PersistedTaskDecision {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as PersistedTaskDecision
      : {};
  } catch {
    return {};
  }
}

export function estimateOfTaskDecision(decision: PersistedTaskDecision) {
  return parseTaskEstimate(decision.estimate);
}

export function expectedOutputOfTaskDecision(decision: PersistedTaskDecision): string | null {
  return typeof decision.expectedOutput === 'string' && decision.expectedOutput.trim().length > 0
    ? decision.expectedOutput
    : null;
}
