/**
 * v2.7 T06a：来源徽章的**唯一**解析点（`41 §2.5.3`）。
 *
 * `PROBE` 与 `RETEST` 在 `PlanTask.sourceKind` 上都落 `RETEST`（调度层合并），
 * 但用户必须能分辨「到日子该复测」和「证据不足才补测」。
 * 解析只能经 `PlanTask.candidateId → TaskCandidate.sourceKind`：
 * 用 `PlanTask.module` 兜底只是**碰巧对** —— 到期复测的 module 恒为
 * `EVIDENCE_RETEST`，一旦某条 PROBE 的 module 也落成它，两者徽章立刻合流。
 *
 * 纯函数：客户端组件可以值导入，不会把 prisma 打进浏览器包（G-5③）。
 */

import { taskSourceLabel } from '../constants';
import type { ModuleId, TaskSourceKind } from '../types';
import type { CandidateSourceKind } from './taskCandidate';

export type SourceBadgeTone =
  | 'probe'
  | 'retest'
  | 'review'
  | 'material'
  | 'weakness'
  | 'core';

export interface SourceBadge {
  label: string;
  tone: SourceBadgeTone;
}

export interface BadgeTaskInput {
  sourceKind: TaskSourceKind;
  module: ModuleId;
  candidateId: string | null;
}

export interface BadgeCandidateInput {
  sourceKind: CandidateSourceKind;
}

export function resolveSourceBadge(
  task: BadgeTaskInput,
  candidate: BadgeCandidateInput | null,
): SourceBadge {
  // 只有 candidateId 非空时才允许看候选；候选已被清理则安全回落，不抛异常。
  if (task.candidateId && candidate) {
    if (candidate.sourceKind === 'PROBE') {
      return { label: '补测（证据不足）', tone: 'probe' };
    }
    if (candidate.sourceKind === 'RETEST') {
      return { label: '到期复测', tone: 'retest' };
    }
    if (candidate.sourceKind === 'REVIEW') {
      return { label: '复习', tone: 'review' };
    }
    if (candidate.sourceKind === 'MATERIAL') {
      return { label: '材料任务', tone: 'material' };
    }
  }
  if (task.sourceKind === 'WEAKNESS') {
    return { label: taskSourceLabel(task.sourceKind), tone: 'weakness' };
  }
  if (task.sourceKind === 'MANUAL') {
    return { label: '材料任务', tone: 'material' };
  }
  return { label: taskSourceLabel(task.sourceKind), tone: 'core' };
}
