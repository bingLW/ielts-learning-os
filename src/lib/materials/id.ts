/**
 * 本地 ID 生成器。
 *
 * 为什么不复用 Prisma 的 `@default(cuid())`：上传流程需要**先**得到 id 才能决定
 * 落盘目录（`materials/{id}/original.ext`），而 Prisma 的 id 只在 `create` 之后才有。
 * 为了「文件先落盘、记录后入库」的顺序（也是 ADR 的要求），这里生成一个
 * 与 cuid 等价的、不可预测的短 id，显式传给 `create({ data: { id } })`。
 *
 * 形态：`{prefix}{base36 时间戳}{12 位随机 hex}`，例如 `cmldt3k9a8f3c2b1d4e5`。
 * - 时间前缀让 id 近似有序（便于排查、也利于 SQLite 主键局部性）；
 * - 随机段保证不可枚举（材料 id 会出现在 URL 里，可枚举等于可探测）。
 */

import { randomBytes } from 'node:crypto';

/** 允许的 id 前缀（均以字母开头，避免被当成数字）。 */
export type IdPrefix = 'cm' | 'ck' | 'pd' | 've' | 'ex' | 'st';

/** 生成一个 6–64 字符、`[A-Za-z0-9_-]` 的 id；与 `storage.assertSafeMaterialId` 兼容。 */
export function createLocalId(prefix: IdPrefix = 'cm'): string {
  const time = Date.now().toString(36);
  const random = randomBytes(6).toString('hex');
  return `${prefix}${time}${random}`;
}
