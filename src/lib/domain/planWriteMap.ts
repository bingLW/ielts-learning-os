/**
 * v2.7 T06a：跨域枚举的**唯一显式映射**（`41 §2.5.1 / §2.5.2`，G-13）。
 *
 * 这里全是纯函数，不碰 prisma。存在的理由只有一个：几个同名但不同域的枚举，
 * 直接赋值不会报错，却会让统计与筛选静默漏行。
 */

import { MODULE_META, MODULE_TO_PRIMARY, MODULE_TRACK } from '../constants';
import type {
  LearningTrack,
  ModuleId,
  PrimarySkill,
  SkillId,
  TaskSourceKind,
} from '../types';
import type { CandidateSourceKind } from './taskCandidate';

/** 候选缺口裁决（与 `SkillGapDraft.kind` 同域，null = 未关联）。 */
export type GapKindForMapping = 'GAP' | 'UNCERTAINTY' | 'UNKNOWN' | null;

/**
 * `TaskCandidate.sourceKind`（8 值）→ `PlanTask.sourceKind`（7 值）。
 *
 * - `REVIEW` / `RETEST` 原样透传，对齐 `adaptivePlan.ts` 写出的值；
 * - `PROBE` 落 `RETEST`：它的调度语义是「为拿证据而做的复测」，且**绝不可**落 `WEAKNESS`
 *   —— 低置信度补测不是弱项强化（AC-6）；
 * - 有已证实缺口（`GAP`）才落 `WEAKNESS`；`UNCERTAINTY`/`UNKNOWN`/null 落 `CORE`；
 * - `EXTENDED`（拓展由引擎自动生成）与 `LEGACY`（v2.0 迁移行）**输出空间不可达**。
 */
export function mapCandidateSourceToPlanTask(
  sourceKind: CandidateSourceKind,
  skillGapKind: GapKindForMapping,
): TaskSourceKind {
  if (sourceKind === 'MATERIAL') return 'MANUAL';
  if (sourceKind === 'REVIEW') return 'REVIEW';
  if (sourceKind === 'RETEST' || sourceKind === 'PROBE') return 'RETEST';
  return skillGapKind === 'GAP' ? 'WEAKNESS' : 'CORE';
}

/**
 * v2.6 `materialPack.ts` 的私有 `skillOfModule()` 收编到此。
 * 行为逐值不变：显式模块映射优先 → targetSkill 特判 → 兜底 `READING`。
 */
export function skillOfModule(module: string, targetSkill: string): SkillId {
  if (module === 'VOCAB_REVIEW') return 'VOCAB';
  if (module === 'SENTENCE') return 'SENTENCE';
  if (module === 'GRAMMAR') return 'GRAMMAR';
  if (module === 'LISTENING') return 'LISTENING';
  if (module === 'SPEAKING') return 'SPEAKING';
  if (module === 'WRITING') return 'WRITING';
  if (targetSkill === 'VOCABULARY') return 'VOCAB';
  if (targetSkill === 'GRAMMAR') return 'GRAMMAR';
  return 'READING';
}

/**
 * `(module, targetSkill)` → `{ skill, primarySkill, track }` 一对三。
 * `TaskCandidate` 只有 module + targetSkill，**没有** track/primarySkill 列，
 * 所以只能从既有常量表派生；禁止调用点自己拼 `if`。
 */
export function taskAxesOf(
  module: ModuleId,
  targetSkill: string,
): { skill: SkillId; primarySkill: PrimarySkill; track: LearningTrack } {
  return {
    skill: skillOfModule(module, targetSkill),
    primarySkill: MODULE_TO_PRIMARY[module],
    track: MODULE_TRACK[module],
  };
}

/** 仅用于诊断/审计：确认 MODULE_META 里的技能口径与收编后的 skillOfModule 是否一致。 */
export function moduleSkillConsistent(module: ModuleId, targetSkill: string): boolean {
  return MODULE_META[module].skill === skillOfModule(module, targetSkill);
}
