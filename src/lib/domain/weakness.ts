/**
 * 薄弱点排序 —— 纯函数（PRD §6.5）。
 *
 * `weakness = 0.35*errRate + 0.25*accGap + 0.15*investGap + 0.15*reviewDebt + 0.10*redDensity`
 *
 * 四条刻意设计：
 * 1. 投入缺口权重最低（0.15）且 `planned=0` 取 0 —— 防止算法退化成「谁练得少就补谁」；
 * 2. 同 key 多来源先去重，各分项取 **max**（不累加，避免重复放大）；
 * 3. 样本阈值 `minQuestions`（默认 10）按**多来源题量之和**判定，达标才进 Top3，否则单列
 *    「数据不足」。阈值衡量「证据有多少」，不能跟着展示口径一起缩水 —— 同 key 两源各 6 题
 *    的真实证据是 12 道题，判「数据不足」会把「知识点分散在多个来源」的维度系统性埋掉；
 * 4. 展示的比率必须**分子分母取自同一样本**，三对各自挑来源（不要求三对同源）。根因是
 *    **比率不可跨样本合并**：`9/10` 与 `0/10` 累加得 45%，而两段真实的差值是 90% 与 0%；
 *    `max 分子 + 累加分母` 会造出「错 5/20 题」却被排第一名的自相矛盾。挑来源的规则**故意
 *    分成两种**：错题率按 **rate** 挑（它是排序依据）；逾期条数与红灯单元数按**分子**挑
 *    （它们是待办量，按 rate 挑会少报要清的条数）。两种挑法都保证取值**与来源顺序无关**。
 */

import {
  ERROR_CATEGORY_LABEL_ZH,
  WEAKNESS_MIN_QUESTIONS,
  WEAKNESS_TOP_N,
  WEAKNESS_WEIGHTS,
} from '../constants';
import type { WeaknessDto } from '../types';
import { accuracyGap } from './accuracy';
import { investGap } from './completion';

/** 候选维度：科目级（6 类）或知识点级（EGIU 单元 / 错误类别）。 */
export interface WeaknessCandidate {
  key: string;
  name: string;
  scope: 'SKILL' | 'KNOWLEDGE';
  totalQuestions: number;
  wrongQuestions: number;
  subjectAcc: number | null;
  dimAcc: number | null;
  plannedMinutes: number;
  actualMinutes: number;
  reviewTotal: number;
  reviewOverdue: number;
  unitTotal: number;
  unitRed: number;
  mainErrorCategory?: string;
  trendDelta?: number;
}

interface ScoreParts {
  errRate: number;
  accGap: number;
  investGap: number;
  reviewDebt: number;
  redDensity: number;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}

function partsOf(candidate: WeaknessCandidate): ScoreParts {
  return {
    errRate: ratio(candidate.wrongQuestions, Math.max(1, candidate.totalQuestions)),
    accGap: accuracyGap(candidate.subjectAcc, candidate.dimAcc),
    investGap: investGap(candidate.plannedMinutes, candidate.actualMinutes),
    reviewDebt: ratio(candidate.reviewOverdue, Math.max(1, candidate.reviewTotal)),
    redDensity: ratio(candidate.unitRed, Math.max(1, candidate.unitTotal)),
  };
}

function scoreOf(parts: ScoreParts): number {
  return (
    WEAKNESS_WEIGHTS.ERR * parts.errRate +
    WEAKNESS_WEIGHTS.ACC_GAP * parts.accGap +
    WEAKNESS_WEIGHTS.INVEST_GAP * parts.investGap +
    WEAKNESS_WEIGHTS.REVIEW_DEBT * parts.reviewDebt +
    WEAKNESS_WEIGHTS.RED_DENSITY * parts.redDensity
  );
}

/**
 * 一对「同源」计数：分子与分母必须来自同一条来源记录。
 *
 * 展示用的分子分母**绝不能跨来源拼装**：分子取 max、分母累加的话，两个来源各「错 5/10」
 * 会显示成「错 5/20 题」（读作 25%），而打分用的是 0.5（50%）—— 一张「才 25% 错」的卡
 * 被排到 Top3 第一名，依据与结论直接打架（PRD §6.5：输出必带依据）。依据错读比不给依据更伤。
 */
interface SamplePair {
  numerator: number;
  denominator: number;
}

/** 一个候选的三对原始计数（每对内部同源）。 */
interface CandidatePairs {
  err: SamplePair;
  review: SamplePair;
  unit: SamplePair;
}

/**
 * 同一 key 多来源合并后的中间态。
 *
 * 三份口径必须分开存放，任何一份被混用都会产生用户可见的错误：
 * - `parts`：供**打分**，各分项取 **max**（PRD §6.5：不累加，避免同一维度被多个来源放大）；
 * - `bestErr` / `bestReview` / `bestUnit`：供**展示**，三对各自挑来源，铁律是
 *   「**每一对分子分母必须来自同一个来源**」（不要求三对来自同一条来源）。挑法**故意不同**，
 *   不是疏漏：
 *   · `bestErr` 按 **errRate** 挑 —— 它是排序依据，比率越高越该先补；
 *   · `bestReview` / `bestUnit` 按 **分子**挑 —— 逾期条数与红灯单元数是**待办量**，
 *     用户读到「逾期 3 条」就是要清 3 条，按比率挑会少报（详见 `shouldReplaceCount`）；
 * - `evidenceQuestions`：供**阈值**，多来源题量累加。
 *
 * ⚠️ 两个题量字段各司其职，不得互相替代：
 * `candidate.totalQuestions` = 最差来源的原始题量（**只用于展示**「错 X/Y」）；
 * `evidenceQuestions` = 全部来源的题量之和（**只用于** `minQuestions` 阈值）。
 * 拿 `candidate.totalQuestions` 判阈值会把「同一知识点分散在多来源」的维度系统性埋掉；
 * 拿 `evidenceQuestions` 做展示就是 D15（分子 max + 分母累加 → 「错 5/20 题」）。
 *
 * 历史缺陷：D14 是「打分被稀释」（合并后仍用累加分母重算比率）；D15 是「展示与打分不同源」
 * （分子取 max、分母累加）。两者在同一函数里，但一个是评分错误、一个是依据错误。
 */
interface MergedEntry {
  candidate: WeaknessCandidate;
  parts: ScoreParts;
  /** 错题率最差来源的原始样本（错 X/Y），回写到 `candidate` 供文案使用。 */
  bestErr: SamplePair;
  /** 复习债最差来源的原始样本（逾期 a/b）。 */
  bestReview: SamplePair;
  /** 红灯密度最差来源的原始样本（红灯 c/d）。 */
  bestUnit: SamplePair;
  /** **只喂阈值**的多来源题量之和，不参与打分、不进任何文案。 */
  evidenceQuestions: number;
  /** 参与合并的来源个数；>1 时文案需加「最差来源」限定词，避免被读成该维度全量统计。 */
  sourceCount: number;
}

/** 取候选自身的三对原始计数。 */
function pairsOf(candidate: WeaknessCandidate): CandidatePairs {
  return {
    err: { numerator: candidate.wrongQuestions, denominator: candidate.totalQuestions },
    review: { numerator: candidate.reviewOverdue, denominator: candidate.reviewTotal },
    unit: { numerator: candidate.unitRed, denominator: candidate.unitTotal },
  };
}

/** 把三对最差样本回写到候选上，保证每对分子分母同源。 */
function applyPairs(candidate: WeaknessCandidate, pairs: CandidatePairs): void {
  candidate.wrongQuestions = pairs.err.numerator;
  candidate.totalQuestions = pairs.err.denominator;
  candidate.reviewOverdue = pairs.review.numerator;
  candidate.reviewTotal = pairs.review.denominator;
  candidate.unitRed = pairs.unit.numerator;
  candidate.unitTotal = pairs.unit.denominator;
}

/**
 * 比率型指标（错题率）是否由新来源接管。
 *
 * 规则：**比率更高者胜；比率相同则取样本量（分母）更大的来源**。
 * 后半条不只是「选得更合理」——它让取值**与来源顺序无关**：同一个知识点无论查询层先返回
 * 哪条来源，卡片依据都一致（比幂等更强的性质）。
 *
 * 只用于 `errRate`：它是**排序依据**，比率越高优先级越高，展示同一来源的绝对数是配套说明。
 */
function shouldReplaceSample(
  incomingRate: number,
  incomingDenominator: number,
  currentRate: number,
  currentDenominator: number,
): boolean {
  if (incomingRate > currentRate) return true;
  return incomingRate === currentRate && incomingDenominator > currentDenominator;
}

/**
 * 计数型指标（逾期条数、红灯单元数）是否由新来源接管。
 *
 * 规则：**分子大者胜；分子相同再比比率**（分子相同 ⇒ 比率高即分母小，比完必分胜负）。
 *
 * 为什么不按比率：这两项是**待办量**，用户读到「逾期 3 条」的意思是「我今天要清 3 条」。
 * 按比率选来源会给出 3 条而实际有 5 条（A 3/4=0.75 胜过 B 5/10=0.5），用户清完 3 条后
 * 卡片不再提示、还剩 2 条悬着 —— 少报待办比「分母不同源」更糟。
 * 分子换来源时分母跟着一起换，所以「同一对内部同源」的铁律不受影响。
 */
function shouldReplaceCount(
  incomingNumerator: number,
  incomingDenominator: number,
  currentNumerator: number,
  currentDenominator: number,
): boolean {
  if (incomingNumerator !== currentNumerator) return incomingNumerator > currentNumerator;
  return ratio(incomingNumerator, incomingDenominator) > ratio(currentNumerator, currentDenominator);
}

/**
 * 同 key 去重合并；`Map` 保持首次出现顺序，保证同一输入结果可复现。
 *
 * 顺序无关的范围：三对计数（`错 X/Y`、`逾期 a/b`、`红灯 c/d`）各自取自「本项最差」的来源，
 * 因此与来源先后无关；但 `name` / `mainErrorCategory` / `trendDelta` 仍取首次出现的来源
 * （名字是用户可读标识，不该被另一条来源改写），故 DTO 整体仍**部分**依赖输入顺序。
 */
function mergeCandidates(candidates: WeaknessCandidate[]): MergedEntry[] {
  const byKey = new Map<string, MergedEntry>();

  for (const candidate of candidates) {
    const parts = partsOf(candidate);
    const pairs = pairsOf(candidate);
    const existing = byKey.get(candidate.key);
    if (!existing) {
      byKey.set(candidate.key, {
        candidate: { ...candidate },
        parts: { ...parts },
        bestErr: pairs.err,
        bestReview: pairs.review,
        bestUnit: pairs.unit,
        evidenceQuestions: Math.max(0, candidate.totalQuestions),
        sourceCount: 1,
      });
      continue;
    }
    // 三对各自决定是否被新来源接管。比较基准必须是「当前该项样本」的原始分子/分母
    // （`existing.bestXxx`），不能用 `candidate.totalQuestions`（首个来源的快照）或任何累加值
    // —— 那会与当前样本不同源，平局判定会跑偏。
    // 顺序也不能反：`existing.parts` 是滚动 max，必须先算完 flag 再更新它，
    // 否则「新比率 > 当前 max」永远为 false。
    const replaceErr = shouldReplaceSample(
      parts.errRate,
      pairs.err.denominator,
      existing.parts.errRate,
      existing.bestErr.denominator,
    );
    // 逾期 / 红灯是**待办量**，按分子（要清的条数）选来源，不按比率。
    const replaceReview = shouldReplaceCount(
      pairs.review.numerator,
      pairs.review.denominator,
      existing.bestReview.numerator,
      existing.bestReview.denominator,
    );
    const replaceUnit = shouldReplaceCount(
      pairs.unit.numerator,
      pairs.unit.denominator,
      existing.bestUnit.numerator,
      existing.bestUnit.denominator,
    );
    // 各分项取 max（PRD §6.5：不累加，避免同一维度被多个来源重复放大）。打分侧口径不变。
    existing.parts = {
      errRate: Math.max(existing.parts.errRate, parts.errRate),
      accGap: Math.max(existing.parts.accGap, parts.accGap),
      investGap: Math.max(existing.parts.investGap, parts.investGap),
      reviewDebt: Math.max(existing.parts.reviewDebt, parts.reviewDebt),
      redDensity: Math.max(existing.parts.redDensity, parts.redDensity),
    };
    // 每一对整体替换，绝不允许「分子来自 A、分母来自 B」。
    if (replaceErr) existing.bestErr = pairs.err;
    if (replaceReview) existing.bestReview = pairs.review;
    if (replaceUnit) existing.bestUnit = pairs.unit;
    // 题量**累加只服务于阈值**：真实证据量是各来源之和，不参与打分、不进文案。
    existing.evidenceQuestions += Math.max(0, candidate.totalQuestions);
    existing.sourceCount += 1;
    // 名称保留首次出现的（已是用户可读的维度名），不做覆盖
  }

  const merged = [...byKey.values()];
  // 合并结束后统一回写三对样本，供 `buildEvidence` / `buildActionHint` 读取。
  for (const entry of merged) {
    applyPairs(entry.candidate, {
      err: entry.bestErr,
      review: entry.bestReview,
      unit: entry.bestUnit,
    });
  }
  return merged;
}

/**
 * 依据文案：`错 7/12 题 · 主要类别=记忆混淆 · 较上周↑3`。
 *
 * `candidate` 上的三对计数已在 `mergeCandidates` 末尾回写为「**本项**最差来源」的原始样本，
 * 所以每段依据读到的都是同源分子分母。注意三段可能来自三个不同来源 —— 后缀「（最差来源）」
 * 只标注最近的那个数字「不是该维度的全量统计」，不表示三段同源；绝对数段（逾期 / 红灯）
 * 不加后缀，因为它们不是比率，不会被误读成百分比。
 */
function buildEvidence(candidate: WeaknessCandidate, sourceCount: number): string {
  const segments: string[] = [];
  if (candidate.totalQuestions > 0) {
    const suffix = sourceCount > 1 ? '（最差来源）' : '';
    segments.push(`错 ${candidate.wrongQuestions}/${candidate.totalQuestions} 题${suffix}`);
  }
  if (candidate.mainErrorCategory) {
    const label =
      ERROR_CATEGORY_LABEL_ZH[
        candidate.mainErrorCategory as keyof typeof ERROR_CATEGORY_LABEL_ZH
      ] ?? candidate.mainErrorCategory;
    segments.push(`主要类别=${label}`);
  }
  if (candidate.reviewOverdue > 0) {
    segments.push(`逾期复习 ${candidate.reviewOverdue} 条`);
  }
  if (candidate.unitRed > 0) {
    segments.push(`红灯单元 ${candidate.unitRed} 个`);
  }
  if (typeof candidate.trendDelta === 'number' && candidate.trendDelta !== 0) {
    segments.push(candidate.trendDelta > 0 ? `较上周↑${candidate.trendDelta}` : `较上周↓${Math.abs(candidate.trendDelta)}`);
  }
  return segments.length > 0 ? segments.join(' · ') : '证据不足';
}

/** 行动建议：给多少分钟、先清哪些债。 */
function buildActionHint(candidate: WeaknessCandidate): string {
  if (candidate.reviewOverdue > 0) {
    return `先清 ${candidate.reviewOverdue} 条逾期复习，再追加 15 分钟专项练习`;
  }
  if (candidate.unitRed > 0) {
    return `重学 ${candidate.unitRed} 个红灯单元并当日复测至黄灯以上`;
  }
  return '本周计划中追加 15 分钟专项练习';
}

/**
 * 排序。
 *
 * @param candidates 已算好原始计数的候选维度
 * @param opts.minQuestions 样本阈值，默认 10
 * @param opts.limit Top N，默认 3
 */
export function rankWeaknesses(
  candidates: WeaknessCandidate[],
  opts?: { minQuestions?: number; limit?: number },
): { ranked: WeaknessDto[]; insufficient: WeaknessDto[] } {
  const minQuestions = opts?.minQuestions ?? WEAKNESS_MIN_QUESTIONS;
  const limit = opts?.limit ?? WEAKNESS_TOP_N;

  const merged = mergeCandidates(candidates);

  // D14：直接用合并阶段算好的 `parts` 打分（各分项已取 max），
  // 绝不用「累加后的分母」重算比率；D15：展示读回写后的 `candidate`（三对同源样本）。
  const scored = merged.map(({ candidate, parts, sourceCount, evidenceQuestions }) => {
    const score = scoreOf(parts);
    const dto: WeaknessDto = {
      name: candidate.name,
      score: Math.round(score * 1000) / 1000,
      evidence: buildEvidence(candidate, sourceCount),
      actionHint: buildActionHint(candidate),
    };
    // `evidenceQuestions` 只在这里出现：阈值判定用「多来源证据总量」，
    // 绝不能用 `candidate.totalQuestions`（那是展示用的最差来源原始题量）。
    return { candidate, dto, evidenceQuestions };
  });

  const eligible = scored.filter((entry) => entry.evidenceQuestions >= minQuestions);
  const insufficient = scored
    .filter((entry) => entry.evidenceQuestions < minQuestions)
    .sort((a, b) => b.dto.score - a.dto.score)
    .map((entry) => entry.dto);

  const ranked = eligible
    .sort((a, b) => b.dto.score - a.dto.score || a.dto.name.localeCompare(b.dto.name))
    .slice(0, limit)
    .map((entry) => entry.dto);

  return { ranked, insufficient };
}
