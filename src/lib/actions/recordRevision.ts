/**
 * 字段级修订历史写入器（P1-03）。
 *
 * 注意：本文件**不是** Server Action（没有 `'use server'`），因为它需要在事务里
 * 被别的 action 调用，且会接收 `tx` 参数。
 */

import type { Prisma } from '@prisma/client';
import { stringify } from '@/lib/json';

/** 需要留痕的字段（顺序即 UI 展示顺序）。 */
export const TRACKED_FIELDS = [
  'recordDate',
  'skill',
  'resourceId',
  'chapter',
  'content',
  'plannedMinutes',
  'actualMinutes',
  'status',
  'totalQuestions',
  'correctQuestions',
  'difficulty',
  'outputText',
  'problemText',
  'errorTypes',
  'nextReviewDate',
  'ext',
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

/** 把任意字段值转成可比较、可展示的字符串。 */
function toComparable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stringify(value);
}

/** 记录快照（Prisma model 或普通对象均可）。 */
export type RecordSnapshot = Record<string, unknown>;

/**
 * 逐字段 diff 并写 `RecordRevision`（append-only，只 insert）。
 *
 * @returns 写入的行数
 */
export async function writeFieldRevisions(
  tx: Prisma.TransactionClient,
  recordId: string,
  before: RecordSnapshot,
  after: RecordSnapshot,
): Promise<number> {
  const rows: { recordId: string; field: string; beforeValue: string | null; afterValue: string | null }[] = [];

  for (const field of TRACKED_FIELDS) {
    const beforeValue = toComparable(before[field]);
    const afterValue = toComparable(after[field]);
    if (beforeValue === afterValue) continue;
    rows.push({ recordId, field, beforeValue, afterValue });
  }

  if (rows.length === 0) return 0;
  await tx.recordRevision.createMany({ data: rows });
  return rows.length;
}
