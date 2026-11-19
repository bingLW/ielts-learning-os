/**
 * JSON 字段的唯一序列化 / 反序列化入口。
 *
 * SQLite 不支持标量数组，schema 里所有数组与对象都存成 `String`（JSON 文本）。
 * 统一走这里可以避免到处 `JSON.parse` + 类型断言，也避免脏数据把页面炸掉。
 */

/** 安全解析：任何异常或 `null` 都退回 `fallback`。 */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** 安全解析字符串数组，并剔除空值与非字符串项。 */
export function parseStringArray(raw: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** 安全解析数字数组。 */
export function parseNumberArray(raw: string | null | undefined): number[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
}

/** 安全解析对象（非数组、非 null）。 */
export function parseObject<T extends Record<string, unknown>>(
  raw: string | null | undefined,
  fallback: T,
): T {
  const parsed = parseJson<unknown>(raw, fallback);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
  return parsed as T;
}

/**
 * 序列化。`undefined` / 空串 → `null`（落库为 NULL，减少无意义的 "undefined" 文本）。
 * 绝不抛异常。
 */
export function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null;
    return text;
  } catch {
    return null;
  }
}

/** 序列化字符串数组；空数组落库为 `"[]"`（保持列非空语义）。 */
export function stringifyArray(values: readonly string[]): string {
  return JSON.stringify(values);
}
