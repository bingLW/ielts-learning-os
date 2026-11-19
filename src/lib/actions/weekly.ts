'use server';

/**
 * 周复盘 Server Actions（T29）。
 *
 * 关键点：**auto 值由服务端重算**，客户端只提交「覆盖值」。
 * 这样即使前端缓存过期或被人为改写，落库的 auto 仍然可信；
 * `(isoYear, isoWeek)` 唯一，用 upsert 保证同一周只有一条。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { WEEKLY_TOP3_COUNT } from '@/lib/constants';
import {
  buildWeeklyMetrics,
  formatWeeklyExportText,
  isPartialWeek,
  mergeWeeklyMetrics,
  normalizeTop3,
  toStoredMetrics,
  validateTop3,
} from '@/lib/domain/weekly';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { saveWeeklyReviewSchema } from '@/lib/schema/weekly';
import { getWeeklyRawInput, getWeeklyReview } from '@/lib/queries/weekly';
import type { ActionResult } from '@/lib/types';

/** 保存（upsert）某周复盘。 */
export async function saveWeeklyReviewAction(
  raw: unknown,
): Promise<ActionResult<{ id: string; isoYear: number; isoWeek: number }>> {
  const parsed = saveWeeklyReviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const top3 = normalizeTop3(input.top3);
  const top3Check = validateTop3(top3);
  if (!top3Check.ok) {
    return fail('VALIDATION', top3Check.message, { top3: top3Check.message });
  }

  // auto 一律服务端重算，客户端只提供 override
  const raw4Metrics = await getWeeklyRawInput(input.weekStart, input.weekEnd);
  const drafts = buildWeeklyMetrics(raw4Metrics);
  const overrideMap = new Map<string, string | null>();
  for (const metric of input.metrics) {
    const value = metric.overrideValue ?? null;
    overrideMap.set(metric.key, value && value.trim().length > 0 ? value.trim() : null);
  }

  const merged = mergeWeeklyMetrics(drafts, null).map((metric) => {
    const override = overrideMap.get(metric.key) ?? null;
    return {
      ...metric,
      overrideValue: override,
      overridden: override !== null,
      effectiveValue: override ?? metric.autoValue,
    };
  });

  const isPartial = input.isPartial ?? isPartialWeek(raw4Metrics.dataDays, raw4Metrics.daysElapsed);
  const metricsText = stringify(toStoredMetrics(merged, new Date().toISOString())) ?? '{}';
  const top3Text =
    stringify(top3.map((item) => ({ ...item, manual: item.manual ?? true }))) ??
    stringify(
      Array.from({ length: WEEKLY_TOP3_COUNT }, () => ({
        name: '',
        score: 0,
        evidence: '',
        manual: true,
      })),
    ) ??
    '[]';

  const saved = await prisma.weeklyReview.upsert({
    where: { isoYear_isoWeek: { isoYear: input.isoYear, isoWeek: input.isoWeek } },
    create: {
      isoYear: input.isoYear,
      isoWeek: input.isoWeek,
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
      isPartial,
      metrics: metricsText,
      top3Weaknesses: top3Text,
      reviewNote: nullIfEmpty(input.reviewNote),
    },
    update: {
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
      isPartial,
      metrics: metricsText,
      top3Weaknesses: top3Text,
      reviewNote: nullIfEmpty(input.reviewNote),
    },
  });

  revalidatePath('/weekly');
  revalidatePath('/');
  return ok({ id: saved.id, isoYear: saved.isoYear, isoWeek: saved.isoWeek });
}

/** 标记导出时间（导出按钮走 Route Handler，这里只补时间戳）。 */
export async function markWeeklyExportedAction(
  raw: unknown,
): Promise<ActionResult<{ id: string; exportedAt: string }>> {
  const parsed = z
    .object({ isoYear: z.coerce.number().int().min(2000).max(2100), isoWeek: z.coerce.number().int().min(1).max(53) })
    .safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.weeklyReview.findUnique({
    where: { isoYear_isoWeek: { isoYear: parsed.data.isoYear, isoWeek: parsed.data.isoWeek } },
  });
  if (!existing) return fail('PRECONDITION', '请先保存该周复盘再导出');

  const updated = await prisma.weeklyReview.update({
    where: { id: existing.id },
    data: { exportedAt: new Date() },
  });

  revalidatePath('/weekly');
  return ok({ id: updated.id, exportedAt: updated.exportedAt?.toISOString() ?? '' });
}

/** 生成纯文本导出内容（供导出按钮下载，也便于人工核对）。 */
export async function buildWeeklyTextAction(
  raw: unknown,
): Promise<ActionResult<{ text: string; fileName: string }>> {
  const parsed = z
    .object({
      isoYear: z.coerce.number().int().min(2000).max(2100),
      isoWeek: z.coerce.number().int().min(1).max(53),
    })
    .safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const existing = await prisma.weeklyReview.findUnique({
    where: { isoYear_isoWeek: { isoYear: parsed.data.isoYear, isoWeek: parsed.data.isoWeek } },
    select: { id: true },
  });
  if (!existing) return fail('PRECONDITION', '请先保存该周复盘再导出');

  // 直接复用查询层的合并逻辑，避免「导出」和「页面」出现两套口径
  const dto = await getWeeklyReview(parsed.data.isoYear, parsed.data.isoWeek);

  return ok({
    text: formatWeeklyExportText(dto),
    fileName: `weekly-${dto.isoYear}-W${String(dto.isoWeek).padStart(2, '0')}.txt`,
  });
}
