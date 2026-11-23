/**
 * 阶段「建议升级」门禁 —— 纯函数（PRD §6.4；v2.7 Q5 改造）。
 *
 * **角色变更（v2.7）**：本函数从此只负责「**人工验收清单完成度**」——
 *
 * - H1（必验维度全部 PASSED）、H2（每个 PASSED 有结果+证据+阶段内日期）、
 *   H3（近 14 天 D7/D14 完成率）、H5（无未处理红灯）共同决定 `suggested`；
 * - H4「投入稳定性」**退出判定**，只作为参考指标出现在 `metrics.h4` 里。
 *
 * 为什么必须退出：H4 的口径是「净时长 ≥ 240 分钟才算达标的一天」，那等于用
 * **一种固定的时间投入模型**替用户决定"够不够格"，而 30 分钟预算的用户
 * 永远不可能达标 —— 那不是在评估能力，是在惩罚日程短的人。投入是否稳定
 * 仍然是值得看的信号，但它不该是晋级的一票否决权。
 *
 * AC-14 的晋级结论由后续的 `computeReadiness()`（五维证据）独家负责。
 * **两者不得互相引用对方的结论**：本函数不看证据维度，readiness 也不看这里的
 * `suggested`。任一方向引用都会让"证据不足"和"清单没填完"重新缠在一起。
 */

import {
  GATE_H3_INTERVALS,
  GATE_H3_MIN_RATE,
  GATE_H3_WINDOW_DAYS,
  GATE_H4_LEGACY_MIN_MINUTES,
  GATE_H4_MIN_BUDGET_MINUTES,
  GATE_H4_MIN_RATIO,
  GATE_H4_WINDOW_DAYS,
  REQUIRED_DIMENSIONS,
} from '../constants';
import { addDays, diffDays } from '../date';
import type { EgiuColor, GateH4Metrics, GateResult, GateUnmetItem, IntervalCode, ReviewResult, ReviewStatus, Verdict } from '../types';

export interface GateInput {
  stageStart: string | null;
  stageEnd: string | null;
  today: string;
  acceptance: {
    dimension: string;
    isRequired: boolean;
    verdict: Verdict;
    myResult: string | null;
    evidence: string | null;
    judgedAt: string | null;
  }[];
  reviewTasks: {
    intervalCode: IntervalCode;
    status: ReviewStatus;
    dueDate: string;
    result: ReviewResult | null;
  }[];
  /**
   * 近 30 天：是否当天有计划、当天净时长、当天**有效预算**。
   *
   * `budgetMinutes` 是**必填**的，而且故意不给默认值：
   * - 默认 0 会让所有日期都掉进"预算太低"的分支，H4 永远显示「—」；
   * - 默认 60 更糟 —— 那是凭空造一个用户从未设定过的基准，
   *   算出来的"达标率"看起来精确、其实是编的。
   *
   * 调用方必须逐日传 `getEffectiveBudget(date).minutes`。运行时若确实拿不到
   * 预算（历史数据缺口 / 调用方疏漏），传 `NaN` 表示"无预算信息"：
   * 该日**不进分母**，并计入 `h4.missingBudgetDays` 让缺口可见。
   */
  days: { date: string; hasPlan: boolean; netMinutes: number; budgetMinutes: number }[];
  lessons: { currentColor: EgiuColor }[];
}

function rateText(rate: number | null): string {
  if (rate === null) return '无数据';
  return `${Math.round(rate * 100)}%`;
}

/**
 * 计算 H1–H3 / H5 与 H4 参考指标。
 *
 * @param input 见 `GateInput`
 */
export function evaluateStageGate(input: GateInput): GateResult {
  const { today, stageStart, stageEnd } = input;

  // ── H1：必验项全部 PASSED ──
  const requiredDimensions = REQUIRED_DIMENSIONS.map((dimension) => {
    const items = input.acceptance.filter((item) => item.dimension === dimension);
    const passed = items.some((item) => item.verdict === 'PASSED');
    return { dimension, passed, hasItem: items.length > 0 };
  });
  const requiredTotal = requiredDimensions.length;
  const requiredPassed = requiredDimensions.filter((item) => item.passed).length;

  const unmetH1: string[] = requiredDimensions
    .filter((item) => !item.passed)
    .map((item) => item.dimension);

  // ── H2：每个 PASSED 都有 myResult + evidence，且 judgedAt 在阶段内 ──
  const passedItems = input.acceptance.filter((item) => item.verdict === 'PASSED');
  const h2Violations: string[] = [];
  for (const item of passedItems) {
    const hasResult = (item.myResult ?? '').trim().length > 0;
    const hasEvidence = (item.evidence ?? '').trim().length > 0;
    const hasDate = (item.judgedAt ?? '').trim().length > 0;
    let inStage = true;
    if (hasDate && stageStart) {
      inStage =
        diffDays(stageStart, item.judgedAt as string) >= 0 &&
        (!stageEnd || diffDays(item.judgedAt as string, stageEnd) >= 0);
    }
    if (!hasResult || !hasEvidence || !hasDate || !inStage) {
      h2Violations.push(item.dimension);
    }
  }

  // ── H3：近 14 天 D7/D14 完成率 ≥ 80% ──
  const h3From = addDays(today, -(GATE_H3_WINDOW_DAYS - 1));
  const h3Tasks = input.reviewTasks.filter(
    (task) =>
      GATE_H3_INTERVALS.includes(task.intervalCode) &&
      diffDays(h3From, task.dueDate) >= 0 &&
      diffDays(task.dueDate, today) >= 0,
  );
  const h3Done = h3Tasks.filter((task) => task.status === 'DONE').length;
  const h3Rate = h3Tasks.length === 0 ? null : h3Done / h3Tasks.length;

  // ── H4：投入稳定性（**参考指标，不参与判定**） ──────────────────────
  //
  // 口径（顺序即语义）：
  // 1. 只看近 30 天**有计划的**日期 —— 没安排学习的日子不该算"没达标"；
  // 2. 预算 < GATE_H4_MIN_BUDGET_MINUTES 的日期**不进分母**（休息日/应急日没有可比性）；
  //    这类日期也不计入 missingBudgetDays —— 它有预算，只是太低；
  // 3. 没有预算信息（NaN/负值）的日期进 `missingBudgetDays`，不进分母；
  // 4. 达标 = 净时长 ≥ 当日预算 × GATE_H4_MIN_RATIO（相对口径，不再是绝对 240 分钟）；
  // 5. 分母为 0 → rate 为 null（展示「—」），**不得当 0**。
  const h4From = addDays(today, -(GATE_H4_WINDOW_DAYS - 1));
  const plannedDaysInWindow = input.days.filter(
    (day) => day.hasPlan && diffDays(h4From, day.date) >= 0 && diffDays(day.date, today) >= 0,
  );

  let missingBudgetDays = 0;
  const eligibleDays: { netMinutes: number; budgetMinutes: number }[] = [];
  for (const day of plannedDaysInWindow) {
    const budget = day.budgetMinutes;
    if (!Number.isFinite(budget) || budget < 0) {
      // 运行时兜底：类型上必填，但 JS 调用方 / 历史数据仍可能缺
      missingBudgetDays += 1;
      continue;
    }
    if (budget < GATE_H4_MIN_BUDGET_MINUTES) continue;
    eligibleDays.push({ netMinutes: day.netMinutes, budgetMinutes: budget });
  }

  const qualifiedDays = eligibleDays.filter(
    (day) => day.netMinutes >= day.budgetMinutes * GATE_H4_MIN_RATIO,
  ).length;
  // 旧 240 分钟口径：同一批 eligible 日，只换单日门槛 —— 这样两个数字可比
  const legacyQualifiedDays = eligibleDays.filter(
    (day) => day.netMinutes >= GATE_H4_LEGACY_MIN_MINUTES,
  ).length;

  const h4: GateH4Metrics = {
    rate: eligibleDays.length === 0 ? null : qualifiedDays / eligibleDays.length,
    qualifiedDays,
    eligibleDays: eligibleDays.length,
    missingBudgetDays,
    legacyRate: eligibleDays.length === 0 ? null : legacyQualifiedDays / eligibleDays.length,
    advisory: true,
  };

  // ── H5：无未处理红灯 ──
  const redLessons = input.lessons.filter((lesson) => lesson.currentColor === 'RED').length;

  const unmet: GateUnmetItem[] = [];

  if (unmetH1.length > 0) {
    unmet.push({
      code: 'H1',
      label: '必验项未全部通过',
      current: `已通过 ${requiredPassed}/${requiredTotal} 个必验维度`,
      target: `听力/阅读/口语/写作/语法各 ≥1 项通过；未通过：${unmetH1.join('、')}`,
    });
  }

  if (h2Violations.length > 0) {
    unmet.push({
      code: 'H2',
      label: '通过项证据不完整',
      current: `${h2Violations.length} 项缺少结果/证据/判定日期或在阶段区间外`,
      target: '每个通过项都必须填「我的实际结果」+「证据」，且判定日期在阶段区间内',
    });
  }

  if (h3Rate === null) {
    unmet.push({
      code: 'H3',
      label: '近 14 天没有 D7/D14 复习记录',
      current: '无数据（分母为 0 视为未满足）',
      target: `近 ${GATE_H3_WINDOW_DAYS} 天 D7/D14 完成率 ≥ ${Math.round(GATE_H3_MIN_RATE * 100)}%`,
    });
  } else if (h3Rate < GATE_H3_MIN_RATE) {
    unmet.push({
      code: 'H3',
      label: `近 ${GATE_H3_WINDOW_DAYS} 天 D7/D14 复习完成率不足`,
      current: rateText(h3Rate),
      target: `≥ ${Math.round(GATE_H3_MIN_RATE * 100)}%`,
    });
  }

  // H4 **不再**产生 unmet 项（v2.7 Q5）。历史痕迹保留在 `metrics.h4.legacyRate`，
  // 由页面以「旧规则参考值」并列展示 —— 留痕，但不再拦人。

  if (redLessons > 0) {
    unmet.push({
      code: 'H5',
      label: '存在未处理红灯单元',
      current: `${redLessons} 个红灯`,
      target: '所有 EGIU/语法单元最新判定为 GREEN 或 YELLOW',
    });
  }

  return {
    suggested: unmet.length === 0,
    unmet,
    metrics: {
      requiredPassed,
      requiredTotal,
      h3Rate,
      h4,
      redLessons,
    },
  };
}
