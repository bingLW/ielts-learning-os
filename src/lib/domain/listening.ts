/**
 * v2.5 Listening & Speaking Lab 领域纯函数。
 *
 * 规则：纯函数、不连数据库、不读系统时间、today 一律由入参传入；
 * 首听与辅助后结果**分离**，绝不覆盖；技术质量问题不计为英语能力错误。
 */

import {
  LISTENING_ERROR_TYPES,
  type ListeningErrorType,
} from '@/lib/constants';

/**
 * 由「首听文本」与「参考转写」做词级对照，产出一份**建议**的错误类型列表。
 *
 * 这是确定性规则建议（可被用户修正），不是 AI 评分：
 * - 参考里有、首听漏掉的词 → MISSED_DETAIL；
 * - 首听里出现参考里没有的词（误听）→ 不在此函数推断（留 UNKNOWN）；
 * - 其余一律 UNKNOWN，交由用户标注。
 */
export function suggestListeningErrors(
  firstListenText: string,
  referenceText: string,
): ListeningErrorType[] {
  const ref = tokenize(referenceText);
  const heard = tokenize(firstListenText);
  if (ref.length === 0) return [];

  const refSet = new Set(ref);
  const missed = ref.filter((word) => !heard.includes(word));
  const result: ListeningErrorType[] = [];
  if (missed.length > 0) result.push('MISSED_DETAIL');
  return result;
}

/** 归一化分词：小写 + 去标点 + 按空白切分。 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * 判断某错误类型是否属于「技术/音频质量」，而非英语能力。
 * AUDIO_QUALITY 恒为技术问题；其余为能力问题。
 */
export function isTechnicalListeningError(errorType: ListeningErrorType): boolean {
  return errorType === 'AUDIO_QUALITY';
}

/**
 * 首听结果与辅助后结果是否都为空。
 * 两者都空 → 该次作答无有效产出（不产生证据）。
 */
export function hasNoListeningOutput(
  firstListenText?: string | null,
  assistedResult?: string | null,
): boolean {
  const first = (firstListenText ?? '').trim();
  const assisted = (assistedResult ?? '').trim();
  return first.length === 0 && assisted.length === 0;
}

/** 校验错误类型是否合法（供 UI 下拉用）。 */
export function isValidListeningErrorType(value: string): value is ListeningErrorType {
  return (LISTENING_ERROR_TYPES as readonly string[]).includes(value);
}

/**
 * 口语评分：由维度得分映射到总体置信度建议。
 *
 * 规则：8 个维度里，若「可理解度」或「发音特征」被标记为技术不可靠，
 * 则总体置信度降为 LOW，且必须建议补测/人工复核。不凭 ASR 转写判发音。
 */
export function speakingConfidenceFromDimensions(
  dimensions: Array<{ key: string; reliable: boolean }>,
): 'LOW' | 'MEDIUM' | 'HIGH' {
  const technicalUnreliable = dimensions.some(
    (dim) => (dim.key === 'intelligibility' || dim.key === 'pronunciation') && !dim.reliable,
  );
  if (technicalUnreliable) return 'LOW';
  const reliableCount = dimensions.filter((dim) => dim.reliable).length;
  if (dimensions.length > 0 && reliableCount === dimensions.length) return 'HIGH';
  return 'MEDIUM';
}

/** 判断是否需要补测（低置信度或技术不可靠时）。 */
export function needsSpeakingFollowUp(confidence: 'LOW' | 'MEDIUM' | 'HIGH'): boolean {
  return confidence === 'LOW';
}
