import {
  PROFILE_SKILLS,
  READINESS_COVERAGE_MIN,
  READINESS_MIN_INDEPENDENT,
  READINESS_MIN_SOURCES,
  READINESS_RETEST_MIN_SCORE,
  READINESS_RETEST_PASS_RATIO,
} from '../constants';
import type { SkillGapDraft } from './skillGap';

export const READINESS_RULE_VERSION = 'v2.7.1-readiness-1';

/** 产品测试维度，不是官方 CEFR 等级表；分母由 DiagnosticBlueprint 题目元数据确定。 */
export const READINESS_STAGE_BLUEPRINTS = {
  PREPARATION: { minLevel: 0, maxLevel: 0 },
  A0_A2: { minLevel: 0, maxLevel: 2 },
  A2_B1: { minLevel: 1, maxLevel: 3 },
  B1_B2: { minLevel: 2, maxLevel: 4 },
} as const;

export type ReadinessOutcome =
  | 'READY_FOR_REVIEW'
  | 'CONTINUE_CURRENT'
  | 'NEED_TARGETED_PRACTICE'
  | 'NEED_MORE_EVIDENCE'
  | 'USER_APPROVED_TRANSITION';

export type ReadinessDimensionCode =
  | 'D1_EVIDENCE_COVERAGE'
  | 'D2_CROSS_SOURCE_CONSISTENCY'
  | 'D3_INDEPENDENT_COMPLETION'
  | 'D4_DELAYED_RETENTION'
  | 'D5_TRANSFER_EVIDENCE';

export type ReadinessDimensionStatus = 'PASS' | 'FAIL' | 'INSUFFICIENT' | 'READ_ERROR';

export interface InvalidEvidenceSample {
  id: string;
  sourceType: 'ATTEMPT' | 'EVIDENCE' | 'RETEST';
  skill: string;
  subskill?: string;
  reason: string;
}

export interface CoverageDimension {
  skill: string;
  subskill: string;
  completed: boolean;
  evidenceRefs: string[];
  sourceKinds: string[];
  itemCodes: string[];
}

export interface SkillCoverage {
  skill: string;
  completed: number;
  required: number;
  coverageRatio: number | null;
  missingSubskills: string[];
  dimensions: CoverageDimension[];
  invalidSamples: InvalidEvidenceSample[];
}

export interface ReadinessDimension {
  code: ReadinessDimensionCode;
  label: string;
  status: ReadinessDimensionStatus;
  detail: string;
  evidenceRefs: string[];
  suggestion: string;
}

export interface EvidenceDistribution {
  baseline: number;
  immediate: number;
  delayed: number;
  applied: number;
  transfer: number;
  independent: number;
  independentEvidenceRefs: string[];
}

export interface RetestOutcome {
  id: string;
  retestType: 'IMMEDIATE' | 'DELAYED' | 'APPLIED' | 'TRANSFER';
  skill: string;
  status: 'PENDING' | 'DONE' | 'SKIPPED' | 'SUPERSEDED';
  score: number | null;
  materialRef: string | null;
  evidenceId: string | null;
  parentEvidenceId: string;
  valid: boolean;
  independent: boolean;
  contextChanged: boolean;
  intervalMet: boolean;
  invalidReason: string | null;
}

export interface ReadinessSnapshot {
  ruleVersion: string;
  dataSnapshotId: string;
  computedAt: string;
  blueprint: { id: string; code: string; version: string; stageProfileCode: string };
  coverageBySkill: Record<string, SkillCoverage>;
  invalidSamples: InvalidEvidenceSample[];
}

export interface ReadinessInput {
  stageId: string;
  stageStart: string | null;
  asOfDate: string;
  officialGaps: SkillGapDraft[];
  officialUncertainties: SkillGapDraft[];
  evidenceBySkill: Record<string, EvidenceDistribution>;
  retestOutcomes: RetestOutcome[];
  distinctSources: {
    skill: string;
    sourceRefs: string[];
    observations?: { sourceRef: string; direction: 'MEETS' | 'BELOW' | 'UNKNOWN'; evidenceRefs: string[] }[];
  }[];
  coverageBySkill: Record<string, SkillCoverage>;
  readErrors: ReadinessDimensionCode[];
}

export interface ReadinessResult {
  outcome: ReadinessOutcome;
  headline: string;
  dimensions: ReadinessDimension[];
  notConsidered: { label: string; value: string }[];
  unmet: string[];
  snapshot: ReadinessSnapshot;
}

const DIMENSION_CODES: ReadinessDimensionCode[] = [
  'D1_EVIDENCE_COVERAGE',
  'D2_CROSS_SOURCE_CONSISTENCY',
  'D3_INDEPENDENT_COMPLETION',
  'D4_DELAYED_RETENTION',
  'D5_TRANSFER_EVIDENCE',
];
const DIMENSION_LABELS: Record<ReadinessDimensionCode, string> = {
  D1_EVIDENCE_COVERAGE: '证据覆盖',
  D2_CROSS_SOURCE_CONSISTENCY: '多来源一致',
  D3_INDEPENDENT_COMPLETION: '无辅助完成',
  D4_DELAYED_RETENTION: '延迟保持',
  D5_TRANSFER_EVIDENCE: '迁移证据',
};
const OFFICIAL_SKILLS: readonly string[] = PROFILE_SKILLS;
const NOT_CONSIDERED = [
  { label: '学习天数', value: '不参与判定' },
  { label: '完成率', value: '不参与判定' },
  { label: '单次 AI 分数', value: '不参与判定' },
];
const HEADLINES: Record<ReadinessOutcome, string> = {
  READY_FOR_REVIEW: '证据已满足阶段结束条件，可以进入人工复核',
  CONTINUE_CURRENT: '证据尚未完全满足，建议继续当前阶段',
  NEED_TARGETED_PRACTICE: '延迟保持或迁移证据未达标，建议安排针对性补练',
  NEED_MORE_EVIDENCE: '证据不足或存在读取失败，先补齐证据再评估',
  USER_APPROVED_TRANSITION: '用户已确认进入下一阶段',
};
const OUTCOME_LABELS: Record<ReadinessOutcome, string> = {
  READY_FOR_REVIEW: 'Ready for review',
  CONTINUE_CURRENT: 'Continue current stage',
  NEED_TARGETED_PRACTICE: 'Need targeted practice',
  NEED_MORE_EVIDENCE: 'Need more evidence',
  USER_APPROVED_TRANSITION: 'User-approved transition',
};

export const READY_OUTCOME: ReadinessOutcome = 'READY_FOR_REVIEW';
export function isReadyOutcome(outcome: string | null): boolean {
  return outcome === READY_OUTCOME;
}
export function readinessOutcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome as ReadinessOutcome] ?? outcome;
}
export function readinessOutcomeHeadline(outcome: string): string | null {
  return HEADLINES[outcome as ReadinessOutcome] ?? null;
}
export function effectiveReadinessOutcome(
  outcome: string | null,
  dimensions: ReadonlyArray<{ status: string }>,
): string | null {
  if (!outcome) return null;
  if (dimensions.some((row) => row.status === 'READ_ERROR')) return 'NEED_MORE_EVIDENCE';
  return outcome;
}

function emptyEvidence(): EvidenceDistribution {
  return {
    baseline: 0, immediate: 0, delayed: 0, applied: 0, transfer: 0,
    independent: 0, independentEvidenceRefs: [],
  };
}
function evidenceOf(input: ReadinessInput, skill: string): EvidenceDistribution {
  return input.evidenceBySkill[skill] ?? emptyEvidence();
}
function coverageOf(input: ReadinessInput, skill: string): SkillCoverage {
  return input.coverageBySkill[skill] ?? {
    skill, completed: 0, required: 0, coverageRatio: null,
    missingSubskills: [], dimensions: [], invalidSamples: [],
  };
}
function refs(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}
function pct(value: number | null): string {
  return value === null ? '未知（未测）' : `${Math.round(value * 100)}%`;
}
function gapDirection(gap: SkillGapDraft): 'COVERAGE' | 'SEVERITY' | 'UNKNOWN' {
  if (gap.coverageRatio === null) return 'UNKNOWN';
  return gap.coverageRatio < READINESS_COVERAGE_MIN ? 'COVERAGE' : 'SEVERITY';
}

function evaluateCoverage(input: ReadinessInput): ReadinessDimension {
  const missing: string[] = [];
  const insufficient: string[] = [];
  const failed: string[] = [];
  const evidenceRefs: string[] = [];
  for (const skill of OFFICIAL_SKILLS) {
    const coverage = coverageOf(input, skill);
    evidenceRefs.push(...coverage.dimensions.flatMap((row) => row.evidenceRefs));
    if (coverage.required === 0 || coverage.coverageRatio === null) {
      missing.push(`${skill}（必测分母未知）`);
    } else if (coverage.missingSubskills.length > 0) {
      insufficient.push(`${skill} ${coverage.completed}/${coverage.required}（${pct(coverage.coverageRatio)}），缺 ${coverage.missingSubskills.join('、')}`);
    } else if (coverage.coverageRatio < READINESS_COVERAGE_MIN) {
      failed.push(`${skill} ${pct(coverage.coverageRatio)}`);
    }
  }
  const evidence = refs(evidenceRefs, input.officialUncertainties.flatMap((row) => row.evidenceIds));
  const suggestion = `按当前阶段 DiagnosticBlueprint 补齐缺失子维度；技术失败、中止和未评分样本需重测。`;
  if (missing.length > 0) {
    return { code: DIMENSION_CODES[0], label: DIMENSION_LABELS[DIMENSION_CODES[0]], status: 'INSUFFICIENT', detail: `必测蓝图未知：${missing.join('；')}`, evidenceRefs: evidence, suggestion };
  }
  if (insufficient.length > 0) {
    return { code: DIMENSION_CODES[0], label: DIMENSION_LABELS[DIMENSION_CODES[0]], status: 'INSUFFICIENT', detail: `必测维度尚未覆盖：${insufficient.join('；')}`, evidenceRefs: evidence, suggestion };
  }
  if (failed.length > 0) {
    return { code: DIMENSION_CODES[0], label: DIMENSION_LABELS[DIMENSION_CODES[0]], status: 'FAIL', detail: `已知覆盖率低于 ${pct(READINESS_COVERAGE_MIN)}：${failed.join('；')}`, evidenceRefs: evidence, suggestion };
  }
  return { code: DIMENSION_CODES[0], label: DIMENSION_LABELS[DIMENSION_CODES[0]], status: 'PASS', detail: `四技能必测子维度均已覆盖，覆盖率 ≥ ${pct(READINESS_COVERAGE_MIN)}`, evidenceRefs: evidence, suggestion };
}

function evaluateConsistency(input: ReadinessInput): ReadinessDimension {
  const insufficient: string[] = [];
  const unknown: string[] = [];
  const mixed: string[] = [];
  const evidenceRefs: string[] = [];
  for (const skill of OFFICIAL_SKILLS) {
    const sourceRow = input.distinctSources.find((row) => row.skill === skill);
    const sources = sourceRow?.sourceRefs ?? [];
    evidenceRefs.push(...sources, ...(sourceRow?.observations?.flatMap((row) => row.evidenceRefs) ?? []));
    if (sources.length < READINESS_MIN_SOURCES) insufficient.push(`${skill}（独立来源 ${sources.length}）`);
    const directions = sourceRow?.observations
      ? new Set(sourceRow.observations.map((row) => row.direction))
      : new Set(input.officialGaps.filter((row) => row.skill === skill).map(gapDirection));
    if (directions.has('UNKNOWN')) unknown.push(skill);
    else if (directions.size > 1) mixed.push(skill);
  }
  const base = { code: DIMENSION_CODES[1], label: DIMENSION_LABELS[DIMENSION_CODES[1]], evidenceRefs: refs(evidenceRefs), suggestion: '用不同题目、材料或真实任务补测；同一答案的重复 AI 评分只算一个来源。' };
  if (insufficient.length > 0) return { ...base, status: 'INSUFFICIENT', detail: `独立来源不足 ${READINESS_MIN_SOURCES} 个：${insufficient.join('；')}` };
  if (unknown.length > 0) return { ...base, status: 'INSUFFICIENT', detail: `缺口方向未知：${unknown.join('、')}` };
  if (mixed.length > 0) return { ...base, status: 'FAIL', detail: `来源间缺口方向不一致：${mixed.join('、')}` };
  return { ...base, status: 'PASS', detail: `每技能至少 ${READINESS_MIN_SOURCES} 个独立来源，方向无冲突` };
}

function evaluateIndependence(input: ReadinessInput): ReadinessDimension {
  const missing: string[] = [];
  const low: string[] = [];
  const evidenceRefs: string[] = [];
  for (const skill of OFFICIAL_SKILLS) {
    const evidence = evidenceOf(input, skill);
    evidenceRefs.push(...evidence.independentEvidenceRefs);
    if (evidence.independent === 0) missing.push(skill);
    else if (evidence.independent < READINESS_MIN_INDEPENDENT) low.push(`${skill}（${evidence.independent} 条）`);
  }
  const base = { code: DIMENSION_CODES[2], label: DIMENSION_LABELS[DIMENSION_CODES[2]], evidenceRefs: refs(evidenceRefs), suggestion: '在 toolsAllowed=[] 且 assistanceLevel=A0 的条件下重做有效任务。' };
  if (missing.length > 0) return { ...base, status: 'INSUFFICIENT', detail: `无有效 A0 无辅助证据：${missing.join('、')}` };
  if (low.length > 0) return { ...base, status: 'FAIL', detail: `有效独立证据不足 ${READINESS_MIN_INDEPENDENT} 条：${low.join('；')}` };
  return { ...base, status: 'PASS', detail: `每技能均有 ≥ ${READINESS_MIN_INDEPENDENT} 条有效 A0 证据` };
}

function evaluateRetention(input: ReadinessInput): ReadinessDimension {
  const rows = input.retestOutcomes.filter((row) => row.retestType === 'DELAYED' && row.status === 'DONE');
  const valid = rows.filter((row) => row.valid && row.independent && row.contextChanged && row.intervalMet);
  const evidenceRefs = valid.map((row) => row.evidenceId ?? row.id);
  const base = { code: DIMENSION_CODES[3], label: DIMENSION_LABELS[DIMENSION_CODES[3]], evidenceRefs: refs(evidenceRefs), suggestion: '到期后用同难度平行材料重测，禁止重做原题或提前结清。' };
  if (valid.length === 0) return { ...base, status: 'INSUFFICIENT', detail: '没有满足间隔、平行任务且独立完成的延迟复测' };
  const passed = valid.filter((row) => row.score !== null && row.score >= READINESS_RETEST_MIN_SCORE).length;
  const ratio = passed / valid.length;
  if (ratio < READINESS_RETEST_PASS_RATIO) return { ...base, status: 'FAIL', detail: `有效延迟复测达标 ${passed}/${valid.length}（${pct(ratio)}）` };
  return { ...base, status: 'PASS', detail: `有效延迟复测达标 ${passed}/${valid.length}（${pct(ratio)}）` };
}

function evaluateTransfer(input: ReadinessInput): ReadinessDimension {
  const rows = input.retestOutcomes.filter((row) => row.retestType === 'APPLIED' || row.retestType === 'TRANSFER');
  const valid = rows.filter((row) => row.status === 'DONE' && row.valid && row.independent && row.contextChanged && row.intervalMet);
  const evidenceRefs = valid.map((row) => row.evidenceId ?? row.id);
  const base = { code: DIMENSION_CODES[4], label: DIMENSION_LABELS[DIMENSION_CODES[4]], evidenceRefs: refs(evidenceRefs), suggestion: '用新材料、新主题或新任务情境完成应用，并保留来源与评分依据。' };
  if (valid.length === 0) return { ...base, status: 'INSUFFICIENT', detail: '没有满足新情境、独立完成和到期条件的应用/迁移证据' };
  const passed = valid.filter((row) => row.score !== null && row.score >= READINESS_RETEST_MIN_SCORE).length;
  if (passed === 0) return { ...base, status: 'FAIL', detail: `${valid.length} 条有效应用/迁移证据均未达标` };
  return { ...base, status: 'PASS', detail: `${passed} 条有效应用/迁移证据达标` };
}

export function computeReadiness(input: ReadinessInput, snapshot: ReadinessSnapshot): ReadinessResult {
  const evaluated = [
    evaluateCoverage(input), evaluateConsistency(input), evaluateIndependence(input),
    evaluateRetention(input), evaluateTransfer(input),
  ];
  const dimensions = evaluated.map((row) => input.readErrors.includes(row.code)
    ? { ...row, status: 'READ_ERROR' as const, detail: '数据读取失败，已阻断 READY' }
    : row);
  let outcome: ReadinessOutcome;
  if (input.readErrors.length > 0 || dimensions.some((row) => row.status === 'INSUFFICIENT')) outcome = 'NEED_MORE_EVIDENCE';
  else if (dimensions.some((row) => (row.code === DIMENSION_CODES[3] || row.code === DIMENSION_CODES[4]) && row.status === 'FAIL')) outcome = 'NEED_TARGETED_PRACTICE';
  else if (dimensions.every((row) => row.status === 'PASS')) outcome = 'READY_FOR_REVIEW';
  else outcome = 'CONTINUE_CURRENT';
  return {
    outcome, headline: HEADLINES[outcome], dimensions, snapshot,
    notConsidered: [...NOT_CONSIDERED],
    unmet: dimensions.filter((row) => row.status !== 'PASS').map((row) => `${row.label}：${row.detail}`),
  };
}
