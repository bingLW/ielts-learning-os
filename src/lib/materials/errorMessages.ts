/**
 * v2.6 材料域错误文案与脱敏工具（G-04）。
 *
 * 任何可能落到 `statusReason` / `syncError` / 客户端可见字段 / 应用日志里的
 * 错误文本，都**不得**包含文件系统绝对路径，也不得包含材料正文全文。
 *
 * 这是一个纯函数工具：它本身不决定"哪里该脱敏"，只提供唯一一处脱敏实现，
 * 调用点（action / pipeline / service）各自套用。v2.3 词汇同步里的
 * `safeSyncError` 之前是内联正则，本文件把它收编为共享实现（见
 * `src/lib/actions/materialVocabulary.ts`）。
 */

/** macOS / Linux 绝对路径：`/Users/…`、`/private/var/…`、`/tmp/…`、`/opt/…`、`/home/…`。 */
const ABSOLUTE_PATH_RE = /(?:file:)?\/(?:Users|private|var|tmp|opt|home|usr|etc|Library)\/[^\s'"，。；]*/g;

/** Windows 绝对路径：`C:\Users\…`、`D:\app\…`。 */
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s'"，。；]*/g;

/** 家目录缩写：`~/…`（不是绝对路径，但同样泄露本机信息，一并脱敏）。 */
const HOME_TILDE_RE = /~\/[^\s'"，。；]*/g;

export const PATH_REDACTED = '（路径已省略）';

/**
 * 把文本里的绝对路径替换成占位符。纯函数，不抛错，空串原样返回。
 */
export function redactMaterialPath(text: string): string {
  return text
    .replace(ABSOLUTE_PATH_RE, PATH_REDACTED)
    .replace(WINDOWS_PATH_RE, PATH_REDACTED)
    .replace(HOME_TILDE_RE, PATH_REDACTED);
}

/**
 * 脱敏 + 长度封顶。超长文本截断并标注被截断的字符数，避免把材料正文全文带进日志。
 */
export function redactMaterialLog(text: string, maxChars = 200): string {
  const redacted = redactMaterialPath(text).replace(/\s+/g, ' ').trim();
  if (redacted.length === 0) return '';
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…（截断 ${redacted.length - maxChars} 字符）`;
}
