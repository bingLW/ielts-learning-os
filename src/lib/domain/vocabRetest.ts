/**
 * 词汇维度延迟复测 —— 纯函数（v2.3 Phase 4）。
 *
 * 练习会话只能证明「当天做对了」；维度要算稳住，必须在隔日、7 天、30 天
 * 各留一条独立证据。这里只负责排期与完成判定，不碰数据库。
 */

import { addDays } from '../date';
import { VOCAB_DIMENSION_STATUSES, type VocabDimension, type VocabDimensionStatus } from '../constants';

/** 复测间隔（天）：隔日 / 7 天 / 30 天，与需求口径一致。 */
export const VOCAB_RETEST_OFFSETS = [1, 7, 30] as const;

/** 单次维度复测的预估分钟。 */
export const VOCAB_RETEST_EST_MINUTES = 3;

/** 只有达到「能回忆」及以上的维度才排复测；能识别不算稳。 */
const RETEST_MIN_STATUS_INDEX = VOCAB_DIMENSION_STATUSES.indexOf('RECALLED');

export function shouldScheduleVocabRetest(status: VocabDimensionStatus): boolean {
  return VOCAB_DIMENSION_STATUSES.indexOf(status) >= RETEST_MIN_STATUS_INDEX;
}

/** 复测排期的机器可读备注：`VOCAB|<itemId>|<dimension>|<lemma>|`。 */
export function vocabRetestNote(itemId: string, dimension: VocabDimension, lemma: string): string {
  return `VOCAB|${itemId}|${dimension}|${lemma}|`;
}

/** 按词条 + 维度过滤复测排期用的前缀。 */
export function vocabRetestNotePrefix(itemId: string, dimension: VocabDimension): string {
  return `VOCAB|${itemId}|${dimension}|`;
}

/** 幂等键：词条 + 维度 + 类型 + 到期日；重跑不会产生新行。 */
export function vocabRetestIdempotencyKey(
  itemId: string,
  dimension: VocabDimension,
  dueDate: string,
): string {
  return `vocab:${itemId}:${dimension}:DELAYED:${dueDate}`;
}

export interface VocabRetestPlanStep {
  retestType: 'DELAYED';
  dueDate: string;
  estMinutes: number;
  idempotencyKey: string;
  note: string;
}

/**
 * 生成一条维度复测阶梯。
 *
 * `baseDate` 是证据的业务日期；阶梯从次日开始，不复用当天。
 */
export function buildVocabRetestPlan(input: {
  itemId: string;
  lemma: string;
  dimension: VocabDimension;
  status: VocabDimensionStatus;
  baseDate: string;
}): VocabRetestPlanStep[] {
  if (!shouldScheduleVocabRetest(input.status)) return [];
  return VOCAB_RETEST_OFFSETS.map((offset) => {
    const dueDate = addDays(input.baseDate, offset);
    return {
      retestType: 'DELAYED' as const,
      dueDate,
      estMinutes: VOCAB_RETEST_EST_MINUTES,
      idempotencyKey: vocabRetestIdempotencyKey(input.itemId, input.dimension, dueDate),
      note: vocabRetestNote(input.itemId, input.dimension, input.lemma),
    };
  });
}

/**
 * 新证据能否结清到期复测。
 *
 * 只在「同词同维度、已到期或逾期」时结清；未来排期保持待办，
 * 避免提前用一条证据把整个阶梯刷成完成。
 */
export function isVocabRetestDue(dueDate: string, businessDate: string): boolean {
  return dueDate <= businessDate;
}
