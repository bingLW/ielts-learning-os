/**
 * zod 共享片段。
 *
 * 为什么不用 `z.enum(CONST_ARRAY)`：zod 的 `z.enum` 要求编译期元组字面量，
 * 而我们的枚举真值集中在 `constants.ts`（普通数组）。这里用 `enumFrom` 在运行期
 * 校验取值集合，既保持「唯一来源」，又能拿到正确的 `z.infer` 输出类型。
 */

import { z } from 'zod';

/** `YYYY-MM-DD` 业务日期。 */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD');

/** ISO 时刻字符串（`DateTime` 序列化后的形态）。 */
export const isoDateTimeString = z.string().min(10, '时刻格式不合法');

/** 可选文本；空串由 Action 层统一转 null。 */
export function optionalText(max = 4000) {
  return z.string().max(max, `长度不得超过 ${max} 字`).optional();
}

/** 可选 ID。 */
export const optionalId = z.string().min(1).optional();

/**
 * 从常量数组构造「枚举校验」。
 *
 * @param values 允许的取值集合（来自 constants.ts）
 * @param label 中文名，用于报错文案
 */
export function enumFrom<T extends string>(values: readonly T[], label: string) {
  const allow = values as readonly string[];
  return z
    .string()
    .refine((value) => allow.includes(value), `「${label}」取值不合法`)
    .transform((value) => value as T);
}

/** 正整数分钟数。 */
export function minutesField(min: number, max: number) {
  return z.coerce
    .number()
    .int('必须为整数')
    .min(min, `不得少于 ${min} 分钟`)
    .max(max, `不得超过 ${max} 分钟`);
}

/** 非负整数。 */
export const nonNegativeInt = z.coerce.number().int('必须为整数').min(0, '不得为负数');

/** 空串一律转 null 的小工具（Action 层落库前用）。 */
export function nullIfEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
