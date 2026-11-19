/**
 * Server Action 返回值构造器。
 *
 * 所有 action 统一使用这套 helper，保证：
 * 1. 失败**返回**而不是 throw；
 * 2. zod 报错被压平成 `fieldErrors`，UI 可直接定位到字段。
 */

import type { ZodError } from 'zod';
import type { ActionErrorCode, ActionResult } from './types';

/** 成功返回。 */
export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

/** 失败返回。 */
export function fail<T>(
  code: ActionErrorCode,
  error: string,
  fieldErrors?: Record<string, string>,
): ActionResult<T> {
  const base: { ok: false; code: ActionErrorCode; error: string } = { ok: false, code, error };
  return fieldErrors ? { ...base, fieldErrors } : base;
}

/**
 * 把 zod 的 `ZodError` 转成 `{ 字段路径: 第一条报错 }`。
 *
 * 不依赖 `error.flatten()`（zod 各版本返回值形态有差异），直接读 `issues`，
 * 因此 zod 3 / zod 4 都能用。
 */
export function zodFieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map((segment) => String(segment)).join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** zod 校验失败的标准返回。 */
export function failValidation<T>(error: ZodError, message = '输入不合法'): ActionResult<T> {
  return fail<T>('VALIDATION', message, zodFieldErrors(error));
}
