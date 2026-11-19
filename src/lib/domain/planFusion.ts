/**
 * v2.2 计划融合：预算 → 证据记录级别提示 —— 纯函数。
 *
 * 只负责「这个预算下建议记录到什么程度」，不生成任务、不改预算。
 * 15 分钟以内不要求完整证据链（维护模式）；60/180 分钟是两个升级门槛。
 */

import { BUDGET_EVIDENCE_LEVEL_HINT_ZH } from '../constants';
import type { EvidenceLevel } from '../types';

export interface BudgetEvidenceHint {
  level: EvidenceLevel | null;
  advice: string;
}

/** 取预算对应的证据级别提示；非法/负数按 0 分钟处理，永不返回空。 */
export function evidenceHintForBudget(minutes: number): BudgetEvidenceHint {
  const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  const hit = BUDGET_EVIDENCE_LEVEL_HINT_ZH.find(
    (entry) => safe >= entry.minMinutes && (entry.maxMinutes === null || safe <= entry.maxMinutes),
  );
  const chosen =
    hit ?? BUDGET_EVIDENCE_LEVEL_HINT_ZH[BUDGET_EVIDENCE_LEVEL_HINT_ZH.length - 1];
  return { level: chosen.level, advice: chosen.advice };
}
