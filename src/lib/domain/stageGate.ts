/**
 * 阶段「建议升级」门禁 —— 纯函数（PRD §6.4）。
 *
 * 只返回**建议**，永不自动切换阶段。H1–H5 全满足才 `suggested = true`；
 * 任一不满足都会出现在 `unmet` 里（UI 据此把按钮置灰并列出差距）。
 */

import {
  GATE_H3_INTERVALS,
  GATE_H3_MIN_RATE,
  GATE_H3_WINDOW_DAYS,
  GATE_H4_MIN_MINUTES,
  GATE_H4_MIN_RATE,
  GATE_H4_WINDOW_DAYS,
  REQUIRED_DIMENSIONS,
} from '../constants';
import { addDays, diffDays } from '../date';
import type { EgiuColor, GateResult, GateUnmetItem, IntervalCode, ReviewResult, ReviewStatus, Verdict } from '../types';

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
  /** 近 30 天：是否当天有计划、当天净时长。 */
  days: { date: string; hasPlan: boolean; netMinutes: number }[];
  lessons: { currentColor: EgiuColor }[];
}

function rateText(rate: number | null): string {
  if (rate === null) return '无数据';
  return `${Math.round(rate * 100)}%`;
}

/**
 * 计算 H1–H5。
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

  // ── H4：近 30 天有计划的日期中，净时长 ≥240min 占比 ≥80% ──
  const h4From = addDays(today, -(GATE_H4_WINDOW_DAYS - 1));
  const plannedDays = input.days.filter(
    (day) => day.hasPlan && diffDays(h4From, day.date) >= 0 && diffDays(day.date, today) >= 0,
  );
  const qualifiedDays = plannedDays.filter((day) => day.netMinutes >= GATE_H4_MIN_MINUTES).length;
  const h4Rate = plannedDays.length === 0 ? null : qualifiedDays / plannedDays.length;

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

  if (h4Rate === null) {
    unmet.push({
      code: 'H4',
      label: '近 30 天没有任何带计划的日期',
      current: '无数据',
      target: `有计划的日期中净时长 ≥ ${GATE_H4_MIN_MINUTES} 分钟的占比 ≥ ${Math.round(GATE_H4_MIN_RATE * 100)}%`,
    });
  } else if (h4Rate < GATE_H4_MIN_RATE) {
    unmet.push({
      code: 'H4',
      label: `近 ${GATE_H4_WINDOW_DAYS} 天达标天数占比不足`,
      current: rateText(h4Rate),
      target: `≥ ${Math.round(GATE_H4_MIN_RATE * 100)}%`,
    });
  }

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
      h4Rate,
      redLessons,
    },
  };
}
