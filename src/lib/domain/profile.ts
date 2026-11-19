/**
 * 分项能力画像纯函数。
 *
 * 口径（v2.2 §4）：
 * - 四项技能各自独立，绝不取平均、绝不换算 CEFR 官方等级或 IELTS Band。
 * - 置信度只是「这批证据能支撑多强的方向判断」，由样本结构与独立性决定。
 * - 证据依据（evidenceBasis）必须可追溯到具体 EvidenceRecord。
 */

import { PROFILE_REVIEW_DAYS } from '../constants';
import type {
  AssistanceLevel,
  EvidenceConfidence,
  LearningEvidenceType,
} from '../types';

export interface ProfileEvidenceInput {
  evidenceType: LearningEvidenceType;
  assistanceLevel: AssistanceLevel;
}

export interface ProfileConfidenceSuggestion {
  confidence: EvidenceConfidence;
  reasons: string[];
  gaps: string[];
}

function independentTypes(rows: ProfileEvidenceInput[]): Set<LearningEvidenceType> {
  return new Set(rows.filter((row) => row.assistanceLevel === 'A0').map((row) => row.evidenceType));
}

/**
 * 建议置信度：
 * - 无基线 → LOW；
 * - 基线 + 任一次独立复测 → MEDIUM；
 * - 基线 + 独立延迟复测 + 独立实际应用/迁移 → HIGH。
 */
export function suggestProfileConfidence(
  rows: ProfileEvidenceInput[],
): ProfileConfidenceSuggestion {
  const types = new Set(rows.map((row) => row.evidenceType));
  const independent = independentTypes(rows);
  const gaps: string[] = [];

  if (!types.has('BASELINE')) gaps.push('还没有无辅助基线（E0）');
  if (!independent.has('BASELINE')) {
    if (types.has('BASELINE')) gaps.push('基线不是 A0 无辅助样本');
  }
  if (![...independent].some((type) => type !== 'BASELINE' && type !== 'ASSISTED')) {
    gaps.push('还没有独立的即时/延迟复测（E2/E3）');
  }
  if (![...independent].some((type) => type === 'APPLIED_TASK' || type === 'TRANSFER')) {
    gaps.push('还没有独立完成的实际应用或迁移证据（E4/E5）');
  }

  if (!independent.has('BASELINE')) {
    return { confidence: 'LOW', reasons: ['缺少可用的 A0 基线，方向判断只能作为待验证猜测'], gaps };
  }

  const hasIndependentRetest = [...independent].some(
    (type) => type === 'IMMEDIATE_RETEST' || type === 'DELAYED_RETEST',
  );
  if (!hasIndependentRetest) {
    return {
      confidence: 'LOW',
      reasons: ['已有基线，但还没有撤掉提示后的独立复测'],
      gaps,
    };
  }

  const hasDelayed = independent.has('DELAYED_RETEST');
  const hasAppliedOrTransfer = independent.has('APPLIED_TASK') || independent.has('TRANSFER');
  if (hasDelayed && hasAppliedOrTransfer) {
    return {
      confidence: 'HIGH',
      reasons: ['基线 + 独立延迟复测 + 独立实际应用/迁移，证据结构完整'],
      gaps,
    };
  }

  return {
    confidence: 'MEDIUM',
    reasons: [
      hasDelayed ? '已有独立延迟复测，但缺实际应用/迁移' : '已有独立即时复测，但缺延迟保持',
    ],
    gaps,
  };
}

/** 由最近评估日 + 置信度推导下次建议复评日（字符串逻辑）。 */
export function profileReviewDueDate(
  confidence: EvidenceConfidence,
  addDaysFn: (date: string, days: number) => string,
  lastAssessedAt: string,
): string {
  return addDaysFn(lastAssessedAt, PROFILE_REVIEW_DAYS[confidence]);
}
