/**
 * 阶段就绪度（T09，PRD §4.9 / AC-14）。
 *
 * 这是「证据够不够宣布阶段结束」的**唯一**结论源，与 `stageGate`（人工验收清单
 * 完成度）职责切分，两者**不得互相引用对方的结论**：
 *
 * - `stageGate.evaluateStageGate()` 回答「验收清单填完没有」（H1/H2/H3/H5 + H4 参考）；
 * - 本函数回答「证据能不能撑起晋级」（五维证据）。
 *
 * 结论映射顺序不可调换（先命中先返回）：
 *
 * 1. `readErrors.length > 0` → `NEED_MORE_EVIDENCE`（PRD §4.9：任一维读取失败，整体
 *    绝不允许给 Ready）；
 * 2. 任一维度 `INSUFFICIENT` → `NEED_MORE_EVIDENCE`；
 * 3. `D4 === 'FAIL'` 或 `D5 === 'FAIL'` → `NEED_TARGETED_PRACTICE`；
 * 4. 五维全 `PASS` → `READY_FOR_REVIEW`；
 * 5. 其余 → `CONTINUE_CURRENT`。
 *
 * `USER_APPROVED_TRANSITION` **不由本函数返回**：它只在用户点「确认进入下一阶段」后
 * 由 `confirmStageTransitionAction` 写入 `StageReadinessReview.outcome`（`userConfirmed`
 * = true + 写 `StageTransitionLog`）。这保证「系统只建议，用户才生效」。
 *
 * F-2 类型级保障：`ReadinessInput` **故意不含** `daysCompleted` / `completionRate` /
 * `planMinutes` / `aiScore`。任何「靠时长或完成率晋级」的实现都拿不到输入 —— 这是
 * 类型层面把「学习天数 / 完成率 / 单次 AI 分数」挡在判定之外（它们只在
 * `notConsidered` 里作为反例展示）。
 */

import {
  PROFILE_SKILLS,
  READINESS_COVERAGE_MIN,
  READINESS_MIN_INDEPENDENT,
  READINESS_MIN_SOURCES,
  READINESS_RETEST_MIN_SCORE,
  READINESS_RETEST_PASS_RATIO,
} from '../constants';
import type { SkillGapDraft } from './skillGap';

export type ReadinessOutcome =
  | 'READY_FOR_REVIEW'
  | 'CONTINUE_CURRENT'
  | 'NEED_TARGETED_PRACTICE'
  | 'NEED_MORE_EVIDENCE'
  | 'USER_APPROVED_TRANSITION';

/** 五维编码（顺序即展示顺序，D1→D5）。 */
export type ReadinessDimensionCode =
  | 'D1_EVIDENCE_COVERAGE'
  | 'D2_CROSS_SOURCE_CONSISTENCY'
  | 'D3_INDEPENDENT_COMPLETION'
  | 'D4_DELAYED_RETENTION'
  | 'D5_TRANSFER_EVIDENCE';

export type ReadinessDimensionStatus = 'PASS' | 'FAIL' | 'INSUFFICIENT' | 'READ_ERROR';

export interface ReadinessDimension {
  code: ReadinessDimensionCode;
  label: string;
  status: ReadinessDimensionStatus;
  /** 人话说明（含具体数字，不含定性评价）。 */
  detail: string;
  evidenceRefs: string[];
}

/** 单技能证据分布（按生命周期类型计数）。 */
export interface EvidenceDistribution {
  baseline: number;
  immediate: number;
  delayed: number;
  applied: number;
  transfer: number;
  independent: number;
}

/** 单条复测结果。 */
export interface RetestOutcome {
  retestType: 'IMMEDIATE' | 'DELAYED' | 'APPLIED' | 'TRANSFER';
  skill: string;
  status: 'PENDING' | 'DONE' | 'SKIPPED' | 'SUPERSEDED';
  score: number | null;
  materialRef: string | null;
}

/**
 * 注意：本类型**故意不含** daysCompleted / completionRate / planMinutes / aiScore。
 * 任何「靠时长或完成率晋级」的实现都拿不到输入 —— 这是 F-2 的类型级保障。
 */
export interface ReadinessInput {
  stageId: string;
  stageStart: string | null;
  asOfDate: string;
  /** OFFICIAL 维度的缺口（来自 SkillGap，必须已按 dimensionKind 过滤）。 */
  officialGaps: SkillGapDraft[];
  /** OFFICIAL 维度的不确定（含 UNKNOWN，必须已按 dimensionKind 过滤）。 */
  officialUncertainties: SkillGapDraft[];
  /** 按官方技能的证据分布。 */
  evidenceBySkill: Record<string, EvidenceDistribution>;
  /** 每条延迟/迁移复测的结果。 */
  retestOutcomes: RetestOutcome[];
  /** 材料/任务来源去重后的集合（多来源一致性用）。 */
  distinctSources: { skill: string; sourceRefs: string[] }[];
  /** 读取失败的维度（PRD §4.9：任一维读取失败 → 整体必须 NEED_MORE_EVIDENCE）。 */
  readErrors: ReadinessDimensionCode[];
}

export interface ReadinessResult {
  outcome: ReadinessOutcome;
  headline: string;
  dimensions: ReadinessDimension[];
  /** 不参与判定的指标（反例展示，PRD §4.9③）。**只用于展示**。 */
  notConsidered: { label: string; value: string }[];
  unmet: string[];
}

/** 五维展示顺序。 */
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

/**
 * 不参与判定的指标（反例展示）。值恒为「不参与判定」：`computeReadiness` 拿不到这些
 * 指标的真实值（输入类型里根本没有），这正是 F-2 想保证的 —— 它们好看，但不作数。
 */
const NOT_CONSIDERED: ReadonlyArray<{ label: string; value: string }> = [
  { label: '学习天数', value: '不参与判定' },
  { label: '完成率', value: '不参与判定' },
  { label: '单次 AI 分数', value: '不参与判定' },
];

/** 官方四项技能（与画像四技能同源）。 */
const OFFICIAL_SKILLS: readonly string[] = PROFILE_SKILLS;

/** 结论人话。 */
const HEADLINES: Record<ReadinessOutcome, string> = {
  READY_FOR_REVIEW: '证据已满足阶段结束条件，可以进入复核',
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

/** UI 判定「是否 Ready」必须走这里，不得在组件里写结论字面量（G-7）。 */
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

/**
 * 展示层不变量：任一维 `READ_ERROR` → 整体结论降级为 `NEED_MORE_EVIDENCE`。
 *
 * 与 `computeReadiness` 的产出一致，但这里用于「回放已落库结论」的展示防线：
 * 即使库里存的是 Ready，只要明细里有读取失败，页面也不得显示 Ready。
 */
export function effectiveReadinessOutcome(
  outcome: string | null,
  dimensions: ReadonlyArray<{ status: string }>,
): string | null {
  if (!outcome) return null;
  if (dimensions.some((row) => row.status === 'READ_ERROR')) return 'NEED_MORE_EVIDENCE';
  return outcome;
}

function emptyEvidence(): EvidenceDistribution {
  return { baseline: 0, immediate: 0, delayed: 0, applied: 0, transfer: 0, independent: 0 };
}

function evidenceOf(input: ReadinessInput, skill: string): EvidenceDistribution {
  return input.evidenceBySkill[skill] ?? emptyEvidence();
}

function sourcesOf(input: ReadinessInput, skill: string): string[] {
  return input.distinctSources.find((row) => row.skill === skill)?.sourceRefs ?? [];
}

function gapsOf(input: ReadinessInput, skill: string): SkillGapDraft[] {
  return input.officialGaps.filter((gap) => gap.skill === skill);
}

function uncertaintiesOf(input: ReadinessInput, skill: string): SkillGapDraft[] {
  return input.officialUncertainties.filter((gap) => gap.skill === skill);
}

/**
 * 缺口方向三态。
 *
 * `coverageRatio === null` 是「方向未知」，**不是「覆盖不足」**：把它并进 COVERAGE 会让
 * 当前数据（coverageRatio 恒 null）下所有缺口同向 → D2「方向一致」恒 PASS，变成假绿灯
 * 空转。方向未知必须显式暴露，交给 D2 判 INSUFFICIENT（「不知道方向 → 证据不足」）。
 */
function gapDirection(gap: SkillGapDraft): 'COVERAGE' | 'SEVERITY' | 'UNKNOWN' {
  if (gap.coverageRatio === null) return 'UNKNOWN';
  return gap.coverageRatio < READINESS_COVERAGE_MIN ? 'COVERAGE' : 'SEVERITY';
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function refsOfGaps(gaps: readonly SkillGapDraft[]): string[] {
  const out = new Set<string>();
  for (const gap of gaps) {
    for (const id of gap.evidenceIds) out.add(id);
  }
  return [...out];
}

/** D1 证据覆盖。 */
function evaluateCoverage(input: ReadinessInput): ReadinessDimension {
  const missingBaseline: string[] = [];
  const blocked: string[] = [];

  for (const skill of OFFICIAL_SKILLS) {
    const evidence = evidenceOf(input, skill);
    if (evidence.baseline + evidence.immediate === 0) {
      missingBaseline.push(skill);
      continue;
    }
    const uncertainties = uncertaintiesOf(input, skill).length;
    const gaps = gapsOf(input, skill);
    // 无缺口 = 未发现弱项，视为完全覆盖；有缺口 = 取最弱一个子维度的覆盖率。
    const coverage = gaps.length === 0 ? 1 : Math.min(...gaps.map((g) => g.coverageRatio ?? 0));
    if (uncertainties > 0 || coverage < READINESS_COVERAGE_MIN) {
      blocked.push(
        `${skill}（不确定 ${uncertainties} 项，覆盖 ${formatPct(coverage)}）`,
      );
    }
  }

  const refs = refsOfGaps([...input.officialGaps, ...input.officialUncertainties]);
  if (missingBaseline.length > 0) {
    return {
      code: 'D1_EVIDENCE_COVERAGE',
      label: DIMENSION_LABELS.D1_EVIDENCE_COVERAGE,
      status: 'INSUFFICIENT',
      detail: `以下技能缺少基线/即时证据：${missingBaseline.join('、')}`,
      evidenceRefs: refs,
    };
  }
  if (blocked.length > 0) {
    return {
      code: 'D1_EVIDENCE_COVERAGE',
      label: DIMENSION_LABELS.D1_EVIDENCE_COVERAGE,
      status: 'FAIL',
      detail: `覆盖不足或存在不确定项：${blocked.join('；')}`,
      evidenceRefs: refs,
    };
  }
  return {
    code: 'D1_EVIDENCE_COVERAGE',
    label: DIMENSION_LABELS.D1_EVIDENCE_COVERAGE,
    status: 'PASS',
    detail: `${OFFICIAL_SKILLS.length} 个官方技能均有基线/即时证据，无不确定项，覆盖 ≥ ${formatPct(READINESS_COVERAGE_MIN)}`,
    evidenceRefs: refs,
  };
}

/** D2 多来源一致。 */
function evaluateConsistency(input: ReadinessInput): ReadinessDimension {
  const singleSource: string[] = [];
  const unknownDirection: string[] = [];
  const mixed: string[] = [];

  for (const skill of OFFICIAL_SKILLS) {
    const sources = sourcesOf(input, skill);
    if (sources.length < READINESS_MIN_SOURCES) {
      singleSource.push(`${skill}（来源 ${sources.length}）`);
      continue;
    }
    const gaps = gapsOf(input, skill);
    const directions = new Set(gaps.map(gapDirection));
    // 优先级：方向未知（不知道 → 证据不足）先于方向冲突（知道但互相矛盾）。
    if (directions.has('UNKNOWN')) {
      unknownDirection.push(skill);
    } else if (directions.size > 1) {
      mixed.push(skill);
    }
  }

  const refs = input.distinctSources.flatMap((row) => row.sourceRefs);
  if (singleSource.length > 0) {
    return {
      code: 'D2_CROSS_SOURCE_CONSISTENCY',
      label: DIMENSION_LABELS.D2_CROSS_SOURCE_CONSISTENCY,
      status: 'INSUFFICIENT',
      detail: `以下技能来源不足 ${READINESS_MIN_SOURCES} 个：${singleSource.join('；')}`,
      evidenceRefs: refs,
    };
  }
  if (unknownDirection.length > 0) {
    return {
      code: 'D2_CROSS_SOURCE_CONSISTENCY',
      label: DIMENSION_LABELS.D2_CROSS_SOURCE_CONSISTENCY,
      status: 'INSUFFICIENT',
      detail: `以下技能的缺口方向未知（coverageRatio 缺失）：${unknownDirection.join('、')}`,
      evidenceRefs: refs,
    };
  }
  if (mixed.length > 0) {
    return {
      code: 'D2_CROSS_SOURCE_CONSISTENCY',
      label: DIMENSION_LABELS.D2_CROSS_SOURCE_CONSISTENCY,
      status: 'FAIL',
      detail: `以下技能的缺口方向不一致：${mixed.join('、')}`,
      evidenceRefs: refs,
    };
  }
  return {
    code: 'D2_CROSS_SOURCE_CONSISTENCY',
    label: DIMENSION_LABELS.D2_CROSS_SOURCE_CONSISTENCY,
    status: 'PASS',
    detail: `每个技能都有 ≥ ${READINESS_MIN_SOURCES} 个来源，且缺口方向一致`,
    evidenceRefs: refs,
  };
}

/** D3 无辅助完成。 */
function evaluateIndependence(input: ReadinessInput): ReadinessDimension {
  const noIndependent: string[] = [];
  const underThreshold: string[] = [];

  for (const skill of OFFICIAL_SKILLS) {
    const independent = evidenceOf(input, skill).independent;
    if (independent === 0) {
      noIndependent.push(skill);
    } else if (independent < READINESS_MIN_INDEPENDENT) {
      underThreshold.push(`${skill}（A0 证据 ${independent} 条）`);
    }
  }

  const refs = refsOfGaps(input.officialGaps);
  if (noIndependent.length > 0) {
    return {
      code: 'D3_INDEPENDENT_COMPLETION',
      label: DIMENSION_LABELS.D3_INDEPENDENT_COMPLETION,
      status: 'INSUFFICIENT',
      detail: `以下技能无 A0 无辅助证据：${noIndependent.join('、')}`,
      evidenceRefs: refs,
    };
  }
  if (underThreshold.length > 0) {
    return {
      code: 'D3_INDEPENDENT_COMPLETION',
      label: DIMENSION_LABELS.D3_INDEPENDENT_COMPLETION,
      status: 'FAIL',
      detail: `以下技能独立完成证据不足 ${READINESS_MIN_INDEPENDENT} 条：${underThreshold.join('；')}`,
      evidenceRefs: refs,
    };
  }
  return {
    code: 'D3_INDEPENDENT_COMPLETION',
    label: DIMENSION_LABELS.D3_INDEPENDENT_COMPLETION,
    status: 'PASS',
    detail: `每个技能都有 ≥ ${READINESS_MIN_INDEPENDENT} 条 A0 无辅助证据`,
    evidenceRefs: refs,
  };
}

/** D4 延迟保持。 */
function evaluateRetention(input: ReadinessInput): ReadinessDimension {
  const delayed = input.retestOutcomes.filter((row) => row.retestType === 'DELAYED');
  const done = delayed.filter((row) => row.status === 'DONE');
  const refs = done.map((row) => row.materialRef).filter((ref): ref is string => ref !== null);

  if (done.length === 0) {
    return {
      code: 'D4_DELAYED_RETENTION',
      label: DIMENSION_LABELS.D4_DELAYED_RETENTION,
      status: 'INSUFFICIENT',
      detail: '没有已完成（DONE）的延迟复测记录',
      evidenceRefs: refs,
    };
  }

  const passed = done.filter(
    (row) => row.score !== null && row.score >= READINESS_RETEST_MIN_SCORE,
  ).length;
  const ratio = passed / done.length;

  if (ratio < READINESS_RETEST_PASS_RATIO) {
    return {
      code: 'D4_DELAYED_RETENTION',
      label: DIMENSION_LABELS.D4_DELAYED_RETENTION,
      status: 'FAIL',
      detail: `延迟复测达标 ${passed}/${done.length}（${formatPct(ratio)}），低于 ${formatPct(READINESS_RETEST_PASS_RATIO)}`,
      evidenceRefs: refs,
    };
  }
  return {
    code: 'D4_DELAYED_RETENTION',
    label: DIMENSION_LABELS.D4_DELAYED_RETENTION,
    status: 'PASS',
    detail: `延迟复测达标 ${passed}/${done.length}（${formatPct(ratio)}）`,
    evidenceRefs: refs,
  };
}

/** D5 迁移证据。 */
function evaluateTransfer(input: ReadinessInput): ReadinessDimension {
  const appliedOrTransfer = input.retestOutcomes.filter(
    (row) => row.retestType === 'APPLIED' || row.retestType === 'TRANSFER',
  );
  const done = appliedOrTransfer.filter((row) => row.status === 'DONE');
  const passed = done.filter(
    (row) => row.score !== null && row.score >= READINESS_RETEST_MIN_SCORE,
  );
  const refs = done.map((row) => row.materialRef).filter((ref): ref is string => ref !== null);

  if (done.length === 0) {
    return {
      code: 'D5_TRANSFER_EVIDENCE',
      label: DIMENSION_LABELS.D5_TRANSFER_EVIDENCE,
      status: 'INSUFFICIENT',
      detail: '没有任何已完成（DONE）的实际应用/迁移证据',
      evidenceRefs: refs,
    };
  }
  if (passed.length === 0) {
    return {
      code: 'D5_TRANSFER_EVIDENCE',
      label: DIMENSION_LABELS.D5_TRANSFER_EVIDENCE,
      status: 'FAIL',
      detail: `有 ${done.length} 条应用/迁移复测完成，但没有一条达标（score ≥ ${READINESS_RETEST_MIN_SCORE}）`,
      evidenceRefs: refs,
    };
  }
  return {
    code: 'D5_TRANSFER_EVIDENCE',
    label: DIMENSION_LABELS.D5_TRANSFER_EVIDENCE,
    status: 'PASS',
    detail: `有 ${passed.length} 条应用/迁移复测达标（score ≥ ${READINESS_RETEST_MIN_SCORE}）`,
    evidenceRefs: refs,
  };
}

/** 给「读取失败」的维度打上 READ_ERROR 状态。 */
function withReadErrors(
  dimensions: ReadinessDimension[],
  readErrors: ReadinessDimensionCode[],
): ReadinessDimension[] {
  if (readErrors.length === 0) return dimensions;
  const failed = new Set(readErrors);
  return dimensions.map((dimension) =>
    failed.has(dimension.code)
      ? { ...dimension, status: 'READ_ERROR' as const, detail: '数据读取失败' }
      : dimension,
  );
}

/**
 * 计算阶段就绪度（五维 → 5 结论）。
 *
 * @param input 已按 `dimensionKind` 过滤的 OFFICIAL 维度输入
 */
export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const evaluated = [
    evaluateCoverage(input),
    evaluateConsistency(input),
    evaluateIndependence(input),
    evaluateRetention(input),
    evaluateTransfer(input),
  ];
  const dimensions = withReadErrors(evaluated, input.readErrors);

  // 结论映射（顺序不可变）：先错误态/证据不足，再针对性补练，最后才可能 Ready。
  let outcome: ReadinessOutcome;
  if (input.readErrors.length > 0) {
    outcome = 'NEED_MORE_EVIDENCE';
  } else if (dimensions.some((dimension) => dimension.status === 'INSUFFICIENT')) {
    outcome = 'NEED_MORE_EVIDENCE';
  } else if (
    dimensions.some(
      (dimension) =>
        (dimension.code === 'D4_DELAYED_RETENTION' || dimension.code === 'D5_TRANSFER_EVIDENCE') &&
        dimension.status === 'FAIL',
    )
  ) {
    outcome = 'NEED_TARGETED_PRACTICE';
  } else if (dimensions.every((dimension) => dimension.status === 'PASS')) {
    outcome = 'READY_FOR_REVIEW';
  } else {
    outcome = 'CONTINUE_CURRENT';
  }

  const unmet = dimensions
    .filter((dimension) => dimension.status !== 'PASS')
    .map((dimension) => `${dimension.label}：${dimension.detail}`);

  return {
    outcome,
    headline: HEADLINES[outcome],
    dimensions,
    notConsidered: [...NOT_CONSIDERED],
    unmet,
  };
}
