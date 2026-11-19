/**
 * 障碍诊断规则（纯函数）。
 *
 * 约束：
 * - 每轮只允许一个「当前聚焦」障碍（跨技能全局唯一）。
 * - 修复完成（DONE）必须挂后测样本；没有后测就不能宣称修复。
 * - 障碍「已解决」需要至少一条带后测样本的已完成修复。
 * - 修复支架只能用 A0–A3；A4（代写/代答）不是支架。
 */

import type {
  BarrierStatus,
  EvidenceSkill,
  InterventionStatus,
} from '@/lib/types';

export interface BarrierRowLike {
  id: string;
  skill: EvidenceSkill;
  status: BarrierStatus;
  selectedFocus: boolean;
  archived: boolean;
}

export type FocusChangeResult =
  | { ok: true; clearIds: string[] }
  | { ok: false; error: string };

/** 计算把某条障碍设为聚焦时需要清掉的其他聚焦项。 */
export function computeFocusChange(
  rows: readonly BarrierRowLike[],
  targetId: string,
): FocusChangeResult {
  const target = rows.find((row) => row.id === targetId);
  if (!target) return { ok: false, error: '障碍不存在或已被删除' };
  if (target.archived) return { ok: false, error: '已归档的障碍不能设为当前聚焦' };
  if (target.status !== 'ACTIVE') return { ok: false, error: '只有「诊断中」的障碍才能设为聚焦' };
  return {
    ok: true,
    clearIds: rows
      .filter((row) => row.selectedFocus && row.id !== targetId)
      .map((row) => row.id),
  };
}

export interface InterventionLike {
  status: InterventionStatus;
  postEvidenceId: string | null;
}

/** 修复能否标记完成：必须已有后测样本。 */
export function canCompleteIntervention(
  postEvidenceId: string | null,
): { ok: true } | { ok: false; error: string } {
  if (!postEvidenceId) {
    return { ok: false, error: '先关联后测样本（修复后的独立产出），再标记完成。' };
  }
  return { ok: true };
}

const TRANSITIONS: Record<InterventionStatus, InterventionStatus[]> = {
  PLANNED: ['RUNNING', 'DONE', 'ABANDONED'],
  RUNNING: ['DONE', 'ABANDONED'],
  DONE: [],
  ABANDONED: [],
};

/** 状态列是 String：未知值按终态处理，避免旧数据/手改数据把页面打崩。 */
function nextStatuses(from: InterventionStatus): InterventionStatus[] {
  return TRANSITIONS[from] ?? [];
}

/** 修复状态只能前进；DONE / ABANDONED 是终态。 */
export function canTransitionIntervention(
  from: InterventionStatus,
  to: InterventionStatus,
): boolean {
  return from === to || nextStatuses(from).includes(to);
}

export function nextInterventionStatuses(from: InterventionStatus): InterventionStatus[] {
  return [from, ...nextStatuses(from)];
}

/** 障碍能否标记「已解决」：至少要有一条带后测样本的已完成修复。 */
export function canResolveBarrier(
  interventions: readonly InterventionLike[],
): { ok: true } | { ok: false; error: string } {
  const done = interventions.filter(
    (item) => item.status === 'DONE' && item.postEvidenceId !== null,
  );
  if (done.length === 0) {
    return {
      ok: false,
      error: '先把至少一条修复标记完成并关联后测样本，再标记障碍已解决。',
    };
  }
  return { ok: true };
}

export interface BarrierStatInput extends BarrierRowLike {}

export interface BarrierStats {
  activeCount: number;
  resolvedCount: number;
  focusId: string | null;
  focusSkill: EvidenceSkill | null;
  skillsWithActive: EvidenceSkill[];
}

/** 汇总诊断页顶部统计（归档不计入）。 */
export function summarizeBarriers(rows: readonly BarrierStatInput[]): BarrierStats {
  const active = rows.filter((row) => !row.archived && row.status === 'ACTIVE');
  const resolved = rows.filter((row) => !row.archived && row.status === 'RESOLVED');
  const focus = active.find((row) => row.selectedFocus) ?? null;
  const skills: EvidenceSkill[] = [];
  for (const row of active) {
    if (!skills.includes(row.skill)) skills.push(row.skill);
  }
  return {
    activeCount: active.length,
    resolvedCount: resolved.length,
    focusId: focus ? focus.id : null,
    focusSkill: focus ? focus.skill : null,
    skillsWithActive: skills,
  };
}
