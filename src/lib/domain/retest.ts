/**
 * 技能型复测与迁移验证 —— 纯函数。
 *
 * 口径（v2.2 §6）：
 * - 复测只针对「技能表现」，与知识型复习（错题 1/3/7/14 天、词汇）是两套队列，互不复用状态。
 * - 复测必须无辅助（A0）；带支架的记录只能算练习，不能把复测标记为完成。
 * - 重做原题 = 实际应用（APPLIED），不是迁移；迁移验证必须换新题/新材料或新情境。
 */

import {
  EVIDENCE_NO_CHAIN_BUDGET_MAX,
  EVIDENCE_STANDARD_BUDGET_MIN,
  RETEST_OFFSET_DAYS,
  RETEST_TYPES,
} from '../constants';
import { diffDays } from '../date';
import type {
  AssistanceLevel,
  EvidenceLevel,
  EvidenceSkill,
  LearningEvidenceType,
  RetestStatus,
  RetestType,
} from '../types';

/** 复测类型 → 应记录的证据类型（E1–E5 生命周期）。 */
const RETEST_TO_EVIDENCE: Record<RetestType, LearningEvidenceType> = {
  IMMEDIATE: 'IMMEDIATE_RETEST',
  DELAYED: 'DELAYED_RETEST',
  APPLIED: 'APPLIED_TASK',
  TRANSFER: 'TRANSFER',
};

export function retestEvidenceType(retestType: RetestType): LearningEvidenceType {
  return RETEST_TO_EVIDENCE[retestType];
}

/** 复测任务分钟 → 记录级别（≤15 Quick / 16–59 Standard / ≥60 Full）。 */
export function retestEvidenceLevel(estMinutes: number): EvidenceLevel {
  if (estMinutes <= EVIDENCE_NO_CHAIN_BUDGET_MAX) return 'QUICK';
  if (estMinutes < EVIDENCE_STANDARD_BUDGET_MIN) return 'STANDARD';
  return 'FULL';
}

/** 复测证据必须独立完成（A0）。 */
export function retestIndependent(assistanceLevel: AssistanceLevel): boolean {
  return assistanceLevel === 'A0';
}

/** 逾期天数：未到期返回 0。 */
export function retestOverdueDays(dueDate: string, todayStr: string): number {
  return Math.max(0, diffDays(dueDate, todayStr));
}

/** 到期状态判断（仅 PENDING 才需要处理）。 */
export function retestIsDue(
  schedule: { status: RetestStatus; dueDate: string },
  todayStr: string,
): boolean {
  return schedule.status === 'PENDING' && schedule.dueDate <= todayStr;
}

export interface TransferParentContext {
  prompt: string | null;
  materialSource: string | null;
  taskId: string | null;
}

export interface TransferCandidateContext {
  prompt: string | null;
  materialSource: string | null;
  taskId: string | null;
}

export type TransferCheck = { ok: true } | { ok: false; error: string };

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 迁移验证条件校验：必须证明「换了新条件」。
 *
 * 能被确定性判定的两类重复直接拒绝：
 * ① 题干与原题完全相同（重做原题 → 只能记实际应用）；
 * ② 仍挂在原计划任务上（同一任务不算新情境）。
 */
export function checkTransferContext(
  parent: TransferParentContext,
  candidate: TransferCandidateContext,
): TransferCheck {
  const parentPrompt = normalizeText(parent.prompt);
  const candidatePrompt = normalizeText(candidate.prompt);
  const candidateMaterial = normalizeText(candidate.materialSource);

  if (!candidatePrompt && !candidateMaterial) {
    return {
      ok: false,
      error: '迁移验证需要写明新题/新材料的具体条件，否则无法证明是「新条件」下的表现。',
    };
  }

  if (parentPrompt && candidatePrompt && parentPrompt === candidatePrompt) {
    return {
      ok: false,
      error: '这与原题完全相同：重做原题只能记为「实际应用」，迁移验证必须换新题或新情境。',
    };
  }

  if (parentPrompt && !candidatePrompt) {
    return {
      ok: false,
      error: '原题题干已存在，迁移验证需填写新题题干以便对照，不能只写材料来源。',
    };
  }

  if (parent.taskId && candidate.taskId && parent.taskId === candidate.taskId) {
    return {
      ok: false,
      error: '仍挂在原计划任务上：迁移验证需在新的任务/情境中完成。',
    };
  }

  return { ok: true };
}

/** 复测证据是否满足「同一技能 + 对应阶段 + 无辅助」。 */
export type RetestEvidenceCheck =
  | { ok: true }
  | { ok: false; error: string };

export function checkRetestEvidence(input: {
  retestType: RetestType;
  parentSkill: EvidenceSkill;
  evidenceSkill: EvidenceSkill;
  evidenceType: LearningEvidenceType;
  assistanceLevel: AssistanceLevel;
}): RetestEvidenceCheck {
  if (input.parentSkill !== input.evidenceSkill) {
    return { ok: false, error: '复测证据的技能必须与父证据一致。' };
  }
  const expected = retestEvidenceType(input.retestType);
  if (input.evidenceType !== expected) {
    return {
      ok: false,
      error: `这次复测应记录为「${expected}」，不是「${input.evidenceType}」。`,
    };
  }
  if (!retestIndependent(input.assistanceLevel)) {
    return { ok: false, error: '复测必须无辅助（A0）；带支架的记录只能算练习。' };
  }
  return { ok: true };
}

export interface RetestStatInput {
  status: RetestStatus;
  dueDate: string;
  retestType: RetestType;
}

export interface RetestStats {
  pending: number;
  overdue: number;
  dueToday: number;
  next7: number;
  done: number;
  skipped: number;
  byType: Record<RetestType, number>;
}

/** 复测队列统计：逾期 / 今日 / 未来 7 天；已完成与已跳过单列。 */
export function summarizeRetests(rows: RetestStatInput[], todayStr: string): RetestStats {
  const byType: Record<RetestType, number> = {
    IMMEDIATE: 0,
    DELAYED: 0,
    APPLIED: 0,
    TRANSFER: 0,
  };
  let pending = 0;
  let overdue = 0;
  let dueToday = 0;
  let next7 = 0;
  let done = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.status === 'DONE') {
      done += 1;
      continue;
    }
    if (row.status === 'SKIPPED' || row.status === 'SUPERSEDED') {
      skipped += 1;
      continue;
    }
    pending += 1;
    byType[row.retestType] += 1;
    const gap = diffDays(todayStr, row.dueDate);
    if (gap < 0) overdue += 1;
    else if (gap === 0) dueToday += 1;
    else if (gap <= 7) next7 += 1;
  }

  return { pending, overdue, dueToday, next7, done, skipped, byType };
}

/** 队列桶排序：逾期 → 今日 → 未来（按到期日升序）。 */
export function sortRetestQueue<T extends { status: RetestStatus; dueDate: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === 'PENDING') return -1;
      if (b.status === 'PENDING') return 1;
    }
    return a.dueDate.localeCompare(b.dueDate);
  });
}

export const RETEST_ORDER: RetestType[] = RETEST_TYPES;
export const RETEST_OFFSETS: Record<RetestType, number> = RETEST_OFFSET_DAYS;
