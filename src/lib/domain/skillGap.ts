/**
 * 技能缺口的**判定**（T02，S1–S7）。
 *
 * 这一层要回答的是「这条证据不足的结论，能不能当成弱项去排任务」。
 * 产品上最贵的错误是**把不确定当确定**：拿 3 条样本就说"你阅读细节题弱"，
 * 然后连着两周排细节题训练 —— 用户练的是系统的错觉。
 *
 * 所以判定顺序不可调换（先命中先返回）：
 *
 * 1. **S1 无基线**（`independentCount === 0`）→ `UNKNOWN`：
 *    系统不假定"没有无辅助证据 = 0 分"。先排一次基线诊断，而不是先判弱项。
 * 2. **S2 置信度低**（`profileConfidence === 'LOW'`）→ `UNCERTAINTY`：
 *    **即使 20 条样本也一样**（AC-6 的核心）。低置信度说明"这批证据本身不可信"，
 *    样本多只是让错误更自信。
 * 3. **S3 样本不足**（`evidenceQuestions < WEAKNESS_MIN_QUESTIONS`）→ `UNCERTAINTY`：
 *    沿用 weakness 域的同一常量，避免两套"样本够不够"的口径。
 * 4. **S4 无时间戳**（`freshnessDays === null`）→ `UNKNOWN`：无从判断新旧。
 * 5. **S5 画像过期**（`freshnessDays > PROFILE_REVIEW_DAYS[confidence]`）：
 *    `HIGH` → 仍然是 `GAP`，只是 DTO 标 `stale=true`；
 *    其余 → `UNCERTAINTY`。
 *    **只降级、不升格**：数据旧了不会把已证实的缺口降成不确定（那会让补测挤掉
 *    真正的弱项强化），而新数据也不会把不确定性升成缺口（那会绕过 S2/S3 的闸门）。
 * 6. **S6 严重度不足**（`severity < minSeverity`）→ 不发射，记入 `suppressed`。
 * 7. **S7** → `GAP`。
 *
 * `stale` 是**派生 DTO 字段，不落库**：`SkillGap` 表只有 `freshnessDays` + `confidence`。
 * 同一事实存两个副本，早晚漂移。
 */

import { PROFILE_REVIEW_DAYS, WEAKNESS_MIN_QUESTIONS } from '../constants';
import type { EvidenceConfidence } from '../types';

/** 维度分层：OFFICIAL 进四项配比，AUXILIARY 永不进分母。 */
export type GapDimensionKind = 'OFFICIAL' | 'AUXILIARY';

/** 缺口裁决（互斥：一个维度在一次快照里只有一个）。 */
export type GapJudgement = 'GAP' | 'UNCERTAINTY' | 'UNKNOWN';

/** 严重度下限：低于它不发射（证据显示该维度并不低于均值）。 */
export const GAP_MIN_SEVERITY = 0.15;

/** 输入信号（由服务层从画像 + 证据聚合而来）。 */
export interface SkillGapSignal {
  dimensionKind: GapDimensionKind;
  /** OFFICIAL: LISTENING|READING|SPEAKING|WRITING；AUXILIARY: GRAMMAR|VOCABULARY|SENTENCE_STRUCTURE */
  skill: string;
  /** 子维度；'' = 技能级 */
  subskill: string;
  /** `SkillProfile.confidence`（无画像时传 'LOW'） */
  profileConfidence: EvidenceConfidence;
  /** A0 无辅助证据条数 */
  independentCount: number;
  /** 该维度全部证据条数 */
  evidenceCount: number;
  /** 参与「样本是否足够」判定的题目数（口径 = `weakness.ts` 的 evidenceQuestions） */
  evidenceQuestions: number;
  /** 最近一条证据距 asOfDate 的天数；null = 无证据 */
  freshnessDays: number | null;
  /** 覆盖比例 0..1；null = 未知 */
  coverageRatio: number | null;
  /** 该维度正确率与合并正确率之差（正数 = 更差），null = 无数据 */
  accuracyDelta: number | null;
  /** 重复错误频次（近 28 天该维度 errorCategory 众数计数） */
  repeatedErrorCount: number;
  /** 支撑证据 id（可追溯，AC-8） */
  evidenceIds: string[];
}

/** 一条缺口裁决结果。 */
export interface SkillGapDraft {
  dimensionKind: GapDimensionKind;
  skill: string;
  subskill: string;
  kind: GapJudgement;
  confidence: EvidenceConfidence;
  evidenceCount: number;
  independentCount: number;
  freshnessDays: number | null;
  coverageRatio: number | null;
  /** 0..1；`UNCERTAINTY` / `UNKNOWN` 恒 0（不得用不确定性冒充严重度） */
  severity: number;
  reason: string;
  evidenceIds: string[];
  /** 来自 `suggestProfileConfidence().gaps` 原文 */
  missingEvidence: string[];
  /** 派生字段，**不落库** */
  stale: boolean;
}

export interface SplitGapsResult {
  gaps: SkillGapDraft[];
  uncertainties: SkillGapDraft[];
  unknowns: SkillGapDraft[];
  /** 因严重度低于下限而未发射的维度（仅诊断用，不入库） */
  suppressed: { skill: string; subskill: string; why: string }[];
}

/** 收敛到 0..1。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 严重度（§2.2.1）：四项加权。
 *
 * 权重之和为 1，各项都先单独收敛到 0..1 —— 这样任意一项异常都不会把总分顶出范围。
 * `coverageRatio === null` 按 0.5 记（"未知"既不奖励也不惩罚），而不是按 0
 * （按 0 会把"没测过覆盖"当成"完全没覆盖"，凭空造出一个高严重度）。
 *
 * @param signal 输入信号
 */
export function computeGapSeverity(signal: SkillGapSignal): number {
  const accuracyDeficit =
    signal.accuracyDelta === null || signal.accuracyDelta <= 0
      ? 0
      : clamp01(signal.accuracyDelta / 0.25);
  const coverageDeficit =
    signal.coverageRatio === null ? 0.5 : clamp01(1 - signal.coverageRatio);
  const recurrenceDeficit = clamp01(
    signal.repeatedErrorCount / (WEAKNESS_MIN_QUESTIONS * 2),
  );
  const freshnessDeficit =
    signal.freshnessDays === null ? 0 : clamp01(signal.freshnessDays / 180);

  return clamp01(
    0.45 * accuracyDeficit
      + 0.25 * coverageDeficit
      + 0.2 * recurrenceDeficit
      + 0.1 * freshnessDeficit,
  );
}

/** 维度展示名（reason 用中文，缺失时回落原值）。 */
function dimensionLabel(signal: SkillGapSignal): string {
  return signal.subskill.length > 0 ? `${signal.skill}/${signal.subskill}` : signal.skill;
}

/** 该维度的派生 stale 标记（不落库）。 */
function isStale(signal: SkillGapSignal): boolean {
  if (signal.freshnessDays === null) return false;
  return signal.freshnessDays > PROFILE_REVIEW_DAYS[signal.profileConfidence];
}

/**
 * 按 S1–S7 判定每个维度。
 *
 * @param signals 维度信号（同一 `dimensionKind|skill|subskill` 不应重复，重复时后者覆盖前者）
 * @param opts `minSeverity` 覆盖默认下限
 */
export function splitGapsAndUncertainty(
  signals: SkillGapSignal[],
  opts: { minSeverity?: number } = {},
): SplitGapsResult {
  const minSeverity = opts.minSeverity ?? GAP_MIN_SEVERITY;
  const result: SplitGapsResult = {
    gaps: [],
    uncertainties: [],
    unknowns: [],
    suppressed: [],
  };

  const base = (signal: SkillGapSignal): Omit<SkillGapDraft, 'kind' | 'severity' | 'reason'> => ({
    dimensionKind: signal.dimensionKind,
    skill: signal.skill,
    subskill: signal.subskill,
    confidence: signal.profileConfidence,
    evidenceCount: signal.evidenceCount,
    independentCount: signal.independentCount,
    freshnessDays: signal.freshnessDays,
    coverageRatio: signal.coverageRatio,
    evidenceIds: [...signal.evidenceIds],
    missingEvidence: [],
    stale: isStale(signal),
  });

  for (const signal of signals) {
    const stale = isStale(signal);
    const shared = { ...base(signal), stale };

    // ── S1：没有 A0 无辅助基线 → 不假定 0 分 ──
    if (signal.independentCount === 0) {
      result.unknowns.push({
        ...shared,
        kind: 'UNKNOWN',
        severity: 0,
        reason: `「${dimensionLabel(signal)}」无 A0 无辅助基线，系统不假定你是 0 分，先排一次基线诊断`,
      });
      continue;
    }

    // ── S2：置信度低 → 样本再多也不判定弱项（AC-6） ──
    if (signal.profileConfidence === 'LOW') {
      result.uncertainties.push({
        ...shared,
        kind: 'UNCERTAINTY',
        severity: 0,
        reason: `「${dimensionLabel(signal)}」画像置信度低，样本再多也不据此判定弱项；先补测`,
      });
      continue;
    }

    // ── S3：样本不足 ──
    if (signal.evidenceQuestions < WEAKNESS_MIN_QUESTIONS) {
      const lack = WEAKNESS_MIN_QUESTIONS - signal.evidenceQuestions;
      result.uncertainties.push({
        ...shared,
        kind: 'UNCERTAINTY',
        severity: 0,
        reason: `「${dimensionLabel(signal)}」样本 ${signal.evidenceQuestions}/${WEAKNESS_MIN_QUESTIONS} 不足，还差 ${lack} 条`,
      });
      continue;
    }

    // ── S4：连时间戳都没有 → 无从判断新旧 ──
    if (signal.freshnessDays === null) {
      result.unknowns.push({
        ...shared,
        kind: 'UNKNOWN',
        severity: 0,
        reason: `「${dimensionLabel(signal)}」没有任何证据时间戳，无法判断结论是否仍然有效`,
      });
      continue;
    }

    // ── S5：画像过期 —— HIGH 仍判 GAP（只标 stale），其余降为不确定 ──
    if (stale) {
      if (signal.profileConfidence !== 'HIGH') {
        result.uncertainties.push({
          ...shared,
          kind: 'UNCERTAINTY',
          severity: 0,
          reason: `「${dimensionLabel(signal)}」画像已过 ${signal.freshnessDays} 天（阈值 ${PROFILE_REVIEW_DAYS[signal.profileConfidence]} 天），先重新评估`,
        });
        continue;
      }
      // HIGH：继续走 S6/S7，只是 DTO 带 stale=true
    }

    // ── S6/S7：算严重度，够高才是 GAP ──
    const severity = computeGapSeverity(signal);
    if (severity < minSeverity) {
      result.suppressed.push({
        skill: signal.skill,
        subskill: signal.subskill,
        why: `严重度 ${severity.toFixed(3)} 低于下限 ${minSeverity}`,
      });
      continue;
    }

    result.gaps.push({
      ...shared,
      kind: 'GAP',
      severity,
      reason:
        `「${dimensionLabel(signal)}」证据 ${signal.evidenceCount} 条（其中无辅助 ${signal.independentCount} 条）、`
        + `覆盖 ${signal.coverageRatio === null ? '未知' : `${Math.round(signal.coverageRatio * 100)}%`}、`
        + `重复错误 ${signal.repeatedErrorCount} 次`
        + (signal.freshnessDays === null ? '' : `、最近证据 ${signal.freshnessDays} 天前`)
        + (stale ? '（画像已过期，结论仍成立但建议重新评估）' : ''),
    });
  }

  return result;
}
