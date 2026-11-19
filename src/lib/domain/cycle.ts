/**
 * 90 天周期与每周复盘的纯规则。
 *
 * 三条约束：
 * 1. 阶段按日期推进（1–14 校准 / 15–56 积累 / 57–90 交付），但进入下一阶段还有证据门槛；
 * 2. 每周只留一个主问题，复盘必须填满输入/输出/反馈/下周决定，迁移证据可后补；
 * 3. 中断恢复只给 24 小时内能完成的最小下一步，不补做积压任务。
 */

import {
  CYCLE_BUILD_END_DAY,
  CYCLE_BUILD_MIN_COMPARABLE_OUTPUTS,
  CYCLE_CALIBRATION_END_DAY,
  CYCLE_TOTAL_DAYS,
  CYCLE_WEEKS,
  RECOVERY_MINIMAL_MINUTES,
  RECOVERY_NEXT_STEP_HOURS,
  WEEKLY_FOCUS_SLOT_LABEL_ZH,
} from '../constants';
import { addDays, diffDays } from '../date';
import type {
  CyclePhaseCode,
  EvidenceLevel,
  LearningEvidenceType,
  WeeklyFocusSlot,
} from '../types';

export interface CycleProgress {
  /** 第几天（从 1 开始；开始日期之前 ≤ 0，超过 90 天继续增大，便于提示）。 */
  dayNumber: number;
  /** 剩余天数（结束当天为 0）。 */
  daysLeft: number;
  /** 进度百分比（0–100）。 */
  percent: number;
  /** 当前日期对应阶段；未开始或已超期时为 null。 */
  phase: CyclePhaseCode | null;
  notStarted: boolean;
  ended: boolean;
}

/** 周期第几天（startDate 当天 = 1）。 */
export function cycleDayNumber(startDate: string, todayStr: string): number {
  return diffDays(startDate, todayStr) + 1;
}

/** 日期所属阶段；超出 1–90 天返回 null。 */
export function cyclePhaseForDay(dayNumber: number): CyclePhaseCode | null {
  if (dayNumber < 1 || dayNumber > CYCLE_TOTAL_DAYS) return null;
  if (dayNumber <= CYCLE_CALIBRATION_END_DAY) return 'CALIBRATION';
  if (dayNumber <= CYCLE_BUILD_END_DAY) return 'BUILD';
  return 'DELIVER';
}

/** 计算进度（纯函数，服务器与客户端共用同一口径）。 */
export function computeCycleProgress(startDate: string, todayStr: string): CycleProgress {
  const dayNumber = cycleDayNumber(startDate, todayStr);
  const ended = dayNumber > CYCLE_TOTAL_DAYS;
  const notStarted = dayNumber < 1;
  const clamped = Math.min(Math.max(dayNumber, 1), CYCLE_TOTAL_DAYS);
  const percent = ended ? 100 : notStarted ? 0 : Math.round((clamped / CYCLE_TOTAL_DAYS) * 100);
  return {
    dayNumber,
    daysLeft: Math.max(0, CYCLE_TOTAL_DAYS - Math.max(dayNumber, 0)),
    percent,
    phase: notStarted || ended ? null : cyclePhaseForDay(dayNumber),
    notStarted,
    ended,
  };
}

/** 周期第几周（1–13）；weekStart 落在周期开始前一周内时归入第 1 周。 */
export function cycleWeekIndex(startDate: string, weekStart: string): number | null {
  const diff = diffDays(startDate, weekStart);
  if (diff < -6 || diff >= CYCLE_TOTAL_DAYS) return null;
  return Math.floor(Math.max(diff, 0) / 7) + 1;
}

/** 第 n 周的起始日（= 周期开始日 + (n-1)×7）。 */
export function cycleWeekStart(startDate: string, weekIndex: number): string {
  return addDays(startDate, (Math.max(1, weekIndex) - 1) * 7);
}

/** 下一阶段；交付阶段之后没有下一阶段。 */
export function nextCyclePhase(phase: CyclePhaseCode): CyclePhaseCode | null {
  if (phase === 'CALIBRATION') return 'BUILD';
  if (phase === 'BUILD') return 'DELIVER';
  return null;
}

export interface CycleGateCounts {
  comparableOutputs: number;
  deliveryEvidence: number;
}

export type CycleGate = { ok: true } | { ok: false; error: string };

/** 阶段推进门槛：校准→积累需可比较输出；积累→交付需实际应用/迁移证据。 */
export function checkPhaseAdvance(from: CyclePhaseCode, counts: CycleGateCounts): CycleGate {
  if (from === 'CALIBRATION') {
    if (counts.comparableOutputs < CYCLE_BUILD_MIN_COMPARABLE_OUTPUTS) {
      return {
        ok: false,
        error: `进入积累阶段前至少需要 ${CYCLE_BUILD_MIN_COMPARABLE_OUTPUTS} 次可比较输出（标准/完整级且带产出原文），当前 ${counts.comparableOutputs} 次`,
      };
    }
    return { ok: true };
  }
  if (from === 'BUILD') {
    if (counts.deliveryEvidence < 1) {
      return {
        ok: false,
        error: '进入交付阶段前至少需要 1 条实际应用或迁移验证证据；换个真实场景再产出一次',
      };
    }
    return { ok: true };
  }
  return { ok: false, error: '交付阶段是最后一阶段；满足条件后直接完成周期' };
}

/** 完成周期门槛：已过积累期，且有实际应用/迁移证据。 */
export function checkCycleCompletion(dayNumber: number, counts: CycleGateCounts): CycleGate {
  if (dayNumber <= CYCLE_BUILD_END_DAY) {
    return {
      ok: false,
      error: `第 ${CYCLE_BUILD_END_DAY} 天前不能结束周期（当前第 ${Math.max(dayNumber, 0)} 天）`,
    };
  }
  if (counts.deliveryEvidence < 1) {
    return { ok: false, error: '完成周期前至少需要 1 条实际应用或迁移验证证据' };
  }
  return { ok: true };
}

/** 可比较输出：非 Quick 级别且带产出原文。 */
export function isComparableEvidence(row: {
  level: EvidenceLevel;
  outputText: string | null;
}): boolean {
  return row.level !== 'QUICK' && (row.outputText ?? '').trim().length > 0;
}

/** 交付阶段证据：实际应用或迁移验证。 */
export function isDeliveryEvidence(row: { evidenceType: LearningEvidenceType }): boolean {
  return row.evidenceType === 'APPLIED_TASK' || row.evidenceType === 'TRANSFER';
}

/** 周复盘必填槽位（迁移证据可后补，不计入必填）。 */
export function weeklyFocusMissingSlots(focus: {
  focusQuestion: string;
  inputText: string | null;
  outputText: string | null;
  feedbackText: string | null;
  nextDecision: string | null;
}): WeeklyFocusSlot[] {
  const missing: WeeklyFocusSlot[] = [];
  if (focus.focusQuestion.trim().length === 0) missing.push('question');
  if ((focus.inputText ?? '').trim().length === 0) missing.push('input');
  if ((focus.outputText ?? '').trim().length === 0) missing.push('output');
  if ((focus.feedbackText ?? '').trim().length === 0) missing.push('feedback');
  if ((focus.nextDecision ?? '').trim().length === 0) missing.push('decision');
  return missing;
}

/** 标记「已复盘」前必须补齐的槽位。 */
export function canReviewWeeklyFocus(focus: {
  focusQuestion: string;
  inputText: string | null;
  outputText: string | null;
  feedbackText: string | null;
  nextDecision: string | null;
}): CycleGate {
  const missing = weeklyFocusMissingSlots(focus);
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    error: `标记已复盘前还缺：${missing.map((slot) => WEEKLY_FOCUS_SLOT_LABEL_ZH[slot]).join('、')}`,
  };
}

/** 已填槽位数量（输入/输出/反馈/迁移证据，0–4），用于周列表进度点。 */
export function weeklyFocusFilledSlots(focus: {
  inputText: string | null;
  outputText: string | null;
  feedbackText: string | null;
  transferEvidenceId: string | null;
}): number {
  return [
    focus.inputText,
    focus.outputText,
    focus.feedbackText,
    focus.transferEvidenceId,
  ].filter((value) => (value ?? '').trim().length > 0).length;
}

export interface RecoveryAdvice {
  /** 最小下一步的截止日期（今天起 24 小时内）。 */
  dueDate: string;
  minimalMinutes: number;
  message: string;
}

/**
 * 中断恢复建议：只给一个 24 小时内可完成的最小下一步，不补积压任务。
 * `missedDays` 仅用于提示语，不影响建议本身。
 */
export function buildRecoveryAdvice(todayStr: string, missedDays = 0): RecoveryAdvice {
  const dueDate = addDays(todayStr, Math.max(1, Math.ceil(RECOVERY_NEXT_STEP_HOURS / 24)));
  const head =
    missedDays > 0
      ? `已中断 ${missedDays} 天：不补做积压任务。`
      : '重新开始：不补做积压任务。';
  return {
    dueDate,
    minimalMinutes: RECOVERY_MINIMAL_MINUTES,
    message: `${head}今天或明天只完成一个 ${RECOVERY_MINIMAL_MINUTES} 分钟内的最小下一步（例如：一条 A0 口语录音、一段 100 词写作、或复习一组错题），截止 ${dueDate}。`,
  };
}

/** 周期总周数（供 UI 渲染周选项卡）。 */
export const CYCLE_TOTAL_WEEKS = CYCLE_WEEKS;
