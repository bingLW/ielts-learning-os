/**
 * Evidence Core 纯函数。
 *
 * 口径（SOP v2.1 §2 / v2.2 §5、§9、§12）：
 * - 只有 A0（无辅助）才算独立表现；A4 代写/代答绝不计为独立产出。
 * - 内部 0–2 评分只在「标明条件下独立完成」时才能给 2。
 * - 基线必须是 A0；辅助版本必须确有工具介入（A1–A4）——两者不能混在一条记录里。
 * - 复测只排「比父证据更靠后」的阶段，已到最后一段（TRANSFER）不再排。
 */

import {
  ASSISTANCE_LEVELS,
  BUDGET_EVIDENCE_LEVEL_HINT_ZH,
  EVIDENCE_OUTPUT_PREVIEW_CHARS,
  EVIDENCE_SCORE_MAX,
  EVIDENCE_SKILLS,
  INDEPENDENT_ASSISTANCE_LEVEL,
  LEARNING_EVIDENCE_TYPES,
  RETEST_DEFAULT_MINUTES,
  RETEST_OFFSET_DAYS,
  RETEST_TYPES,
} from '../constants';
import { addDays } from '../date';
import type {
  AssistanceLevel,
  EvidenceConditionDto,
  EvidenceLevel,
  EvidenceSkill,
  LearningEvidenceType,
  RetestType,
} from '../types';

/** 证据类型在生命周期中的位置（E0→E5）。 */
const CHAIN_INDEX: Record<LearningEvidenceType, number> = {
  BASELINE: 0,
  ASSISTED: 1,
  IMMEDIATE_RETEST: 2,
  DELAYED_RETEST: 3,
  APPLIED_TASK: 4,
  TRANSFER: 5,
};

/** 复测类型对应的生命周期位置。 */
const RETEST_INDEX: Record<RetestType, number> = {
  IMMEDIATE: 2,
  DELAYED: 3,
  APPLIED: 4,
  TRANSFER: 5,
};

export function chainStageIndex(type: LearningEvidenceType): number {
  return CHAIN_INDEX[type];
}

/** 生命周期下一阶段；TRANSFER 之后没有下一段（返回 `null`）。 */
export function nextChainType(type: LearningEvidenceType): LearningEvidenceType | null {
  const index = CHAIN_INDEX[type];
  return LEARNING_EVIDENCE_TYPES.find((item) => CHAIN_INDEX[item] === index + 1) ?? null;
}

/** 只有 A0 计入独立表现。 */
export function isIndependent(assistanceLevel: AssistanceLevel): boolean {
  return assistanceLevel === INDEPENDENT_ASSISTANCE_LEVEL;
}

/** 该辅助级别下允许的最高内部评分：A0 → 2，其余 → 1。 */
export function maxEvidenceScore(assistanceLevel: AssistanceLevel): number {
  return isIndependent(assistanceLevel) ? EVIDENCE_SCORE_MAX : 1;
}

/** 当前预算档建议的记录级别；≤15 分钟不要求证据链（返回 `null`）。 */
export function recommendedEvidenceLevel(minutes: number): EvidenceLevel | null {
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const hit = BUDGET_EVIDENCE_LEVEL_HINT_ZH.find(
    (item) =>
      minutes >= item.minMinutes && (item.maxMinutes === null || minutes <= item.maxMinutes),
  );
  return hit ? hit.level : null;
}

export type EvidenceTypeCheck =
  | { ok: true }
  | { ok: false; code: 'BASELINE_NOT_INDEPENDENT' | 'ASSISTED_WITHOUT_SUPPORT'; error: string };

/**
 * 类型与辅助级别的一致性校验：
 * 基线不能是辅助产出；辅助版本必须确有工具介入。
 */
export function checkTypeAssistance(
  evidenceType: LearningEvidenceType,
  assistanceLevel: AssistanceLevel,
): EvidenceTypeCheck {
  if (evidenceType === 'BASELINE' && !isIndependent(assistanceLevel)) {
    return {
      ok: false,
      code: 'BASELINE_NOT_INDEPENDENT',
      error: '基线必须是无辅助（A0）的原始样本；使用工具后请另建辅助版本。',
    };
  }
  if (evidenceType === 'ASSISTED' && isIndependent(assistanceLevel)) {
    return {
      ok: false,
      code: 'ASSISTED_WITHOUT_SUPPORT',
      error: '辅助版本必须记录工具介入级别（A1–A4）；无辅助样本请记为首版或复测。',
    };
  }
  return { ok: true };
}

/** 输出预览：折叠空白并截断，避免列表页长文本撑破布局。 */
export function previewOutput(
  text: string | null | undefined,
  max = EVIDENCE_OUTPUT_PREVIEW_CHARS,
): string | null {
  if (text === null || text === undefined) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}…`;
}

export interface RetestStepPlan {
  retestType: RetestType;
  dueDate: string;
  estMinutes: number;
  idempotencyKey: string;
}

/**
 * 为一条证据生成复测计划（父证据 → 后续阶段）。
 *
 * 幂等键 = `父证据ID:复测类型:到期日`，满足「同一父证据 + 类型 + 日期不重复生成」。
 */
export function buildRetestPlan(
  parentEvidenceId: string,
  parentType: LearningEvidenceType,
  baseDate: string,
): RetestStepPlan[] {
  const parentIndex = CHAIN_INDEX[parentType];
  if (parentIndex >= CHAIN_INDEX.TRANSFER) return [];

  return RETEST_TYPES.filter((retestType) => RETEST_INDEX[retestType] > parentIndex).map(
    (retestType) => {
      const dueDate = addDays(baseDate, RETEST_OFFSET_DAYS[retestType]);
      return {
        retestType,
        dueDate,
        estMinutes: RETEST_DEFAULT_MINUTES[retestType],
        idempotencyKey: `${parentEvidenceId}:${retestType}:${dueDate}`,
      };
    },
  );
}

/** 条件快照的安全解析（脏数据退回全空，不让页面炸掉）。 */
export function parseEvidenceCondition(raw: string | null | undefined): EvidenceConditionDto | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const tools = Array.isArray(value.toolsAllowed)
      ? value.toolsAllowed.filter((item): item is string => typeof item === 'string')
      : [];
    const asText = (item: unknown): string | null =>
      typeof item === 'string' && item.trim().length > 0 ? item : null;
    const asMinutes = (item: unknown): number | null =>
      typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : null;
    return {
      prompt: asText(value.prompt),
      materialSource: asText(value.materialSource),
      timeLimitMinutes: asMinutes(value.timeLimitMinutes),
      toolsAllowed: tools,
      audience: asText(value.audience),
      environment: asText(value.environment),
    };
  } catch {
    return null;
  }
}

export interface EvidenceStatInput {
  skill: EvidenceSkill;
  evidenceType: LearningEvidenceType;
  assistanceLevel: AssistanceLevel;
  archived?: boolean;
}

export interface EvidenceStats {
  total: number;
  active: number;
  independent: number;
  independentRate: number | null;
  bySkill: Record<EvidenceSkill, number>;
  byType: Record<LearningEvidenceType, number>;
  /** 已走完「基线→辅助→即时复测→延迟复测」核心四段的技能。 */
  chainSkills: EvidenceSkill[];
}

function emptyBySkill(): Record<EvidenceSkill, number> {
  const out = {} as Record<EvidenceSkill, number>;
  for (const skill of EVIDENCE_SKILLS) out[skill] = 0;
  return out;
}

function emptyByType(): Record<LearningEvidenceType, number> {
  const out = {} as Record<LearningEvidenceType, number>;
  for (const type of LEARNING_EVIDENCE_TYPES) out[type] = 0;
  return out;
}

/** 证据覆盖统计：只按「已归档 = 不算」的活动证据计算。 */
export function summarizeEvidence(rows: EvidenceStatInput[]): EvidenceStats {
  const bySkill = emptyBySkill();
  const byType = emptyByType();
  const skillTypes = new Map<EvidenceSkill, Set<LearningEvidenceType>>();
  let active = 0;
  let independent = 0;

  for (const row of rows) {
    if (row.archived) continue;
    active += 1;
    bySkill[row.skill] += 1;
    byType[row.evidenceType] += 1;
    if (isIndependent(row.assistanceLevel)) independent += 1;
    const set = skillTypes.get(row.skill) ?? new Set<LearningEvidenceType>();
    set.add(row.evidenceType);
    skillTypes.set(row.skill, set);
  }

  const coreChain: LearningEvidenceType[] = [
    'BASELINE',
    'ASSISTED',
    'IMMEDIATE_RETEST',
    'DELAYED_RETEST',
  ];
  const chainSkills = EVIDENCE_SKILLS.filter((skill) => {
    const set = skillTypes.get(skill);
    return set !== undefined && coreChain.every((type) => set.has(type));
  });

  return {
    total: rows.length,
    active,
    independent,
    independentRate: active > 0 ? independent / active : null,
    bySkill,
    byType,
    chainSkills,
  };
}

/** 校验辅助级别是否属于 A0–A4（供服务层复用）。 */
export function isKnownAssistanceLevel(value: string): value is AssistanceLevel {
  return (ASSISTANCE_LEVELS as string[]).includes(value);
}
