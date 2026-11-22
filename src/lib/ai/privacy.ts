/**
 * 隐私与脱敏。
 *
 * 原则：日志与 Provider 请求都先经过这里；邮箱、密钥、长数字、
 * 录音/附件 URL 一律替换为占位符，且脱敏是纯函数便于测试。
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const API_KEY_RE = /\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g;
const LONG_DIGITS_RE = /\b\d{11,}\b/g;
const FILE_URL_RE = /\b(https?:\/\/\S+\.(?:mp3|m4a|wav|ogg|webm|pdf|docx?|png|jpe?g))\b/gi;

/** 通用文本脱敏；保留可读性，不改变业务含义。 */
export function redactText(input: string): string {
  return input
    .replace(EMAIL_RE, '[email]')
    .replace(BEARER_RE, '$1[key]')
    .replace(API_KEY_RE, '[key]')
    .replace(FILE_URL_RE, '[file-url]')
    .replace(LONG_DIGITS_RE, '[number]');
}

/**
 * 深度脱敏任意 JSON 值：字符串脱敏、键名不改、层数有上限。
 * 用于 AICallLog.redactedMetadataJson。
 */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]';
  if (typeof value === 'string') return redactText(value).slice(0, 400);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactMetadata(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/key|secret|token|password/i.test(key) && typeof item === 'string') {
        out[key] = '[redacted]';
      } else {
        out[key] = redactMetadata(item, depth + 1);
      }
    }
    return out;
  }
  return '[unsupported]';
}

/**
 * 仅保留作答首句、限制长度，用于诊断引用时防止把整篇作文塞进下游。
 * 原始作答本身仍原样保存在 AILearningTurn，不受裁剪影响。
 */
export function excerpt(text: string, max = 80): string {
  const first = text.trim().split(/[。！？.!?\n]/)[0] ?? '';
  const source = first.length > 0 ? first : text.trim();
  return source.length > max ? `${source.slice(0, max)}…` : source;
}