/**
 * 句子成分分析 —— 纯函数，零 IO。
 *
 * 核心约束（PRD §5.8）：**句子成分（S/V/O/C/Adverbial）与词性（名词/动词/…）
 * 是两个完全独立的取值集**，落在两个独立字段上。任何情况下都不允许：
 * 1. 用同一个字段既存成分又存词性；
 * 2. 拿成分取值去词性集合里校验（或反之）；
 * 3. 因为成分未标注就推断词性。
 */

import {
  PARTS_OF_SPEECH,
  SENTENCE_COMPONENTS,
  SENTENCE_MAX_TOKENS,
} from '../constants';
import type { PartOfSpeech, SentenceComponent, SentenceTokenDto } from '../types';

/** token 级校验错误码。 */
export type SentenceTokenErrorCode =
  | 'EMPTY'
  | 'TOO_MANY'
  | 'MISSING_TEXT'
  | 'INVALID_COMPONENT'
  | 'INVALID_POS';

/** 把句子按空白切成 token 文本（保留原始顺序，不做标点剥离）。 */
export function splitSentence(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);
}

/** 由句子原文生成「未标注」token 列表（成分与词性都是 null）。 */
export function createTokens(text: string): SentenceTokenDto[] {
  return splitSentence(text).map((word) => ({ text: word, component: null, pos: null }));
}

/** token 列表还原成句子（导出/展示用）。 */
export function rebuildSentence(tokens: SentenceTokenDto[]): string {
  return tokens.map((token) => token.text).join(' ');
}

/**
 * 校验 token 列表。
 *
 * 注意：`component` 只与 `SENTENCE_COMPONENTS` 比对，`pos` 只与 `PARTS_OF_SPEECH` 比对，
 * **两者互不校验** —— 这是本模块最重要的一条边界。
 */
export function validateTokens(
  tokens: SentenceTokenDto[],
): { ok: true } | { ok: false; code: SentenceTokenErrorCode; message: string } {
  if (tokens.length === 0) {
    return { ok: false, code: 'EMPTY', message: '至少需要一个句子成分标号' };
  }
  if (tokens.length > SENTENCE_MAX_TOKENS) {
    return {
      ok: false,
      code: 'TOO_MANY',
      message: `最多支持 ${SENTENCE_MAX_TOKENS} 个 token，当前 ${tokens.length} 个`,
    };
  }

  const componentAllow = SENTENCE_COMPONENTS as readonly string[];
  const posAllow = PARTS_OF_SPEECH as readonly string[];

  for (const token of tokens) {
    if (token.text.trim().length === 0) {
      return { ok: false, code: 'MISSING_TEXT', message: '存在空的 token 文本' };
    }
    // 成分：只查成分集合
    if (token.component !== null && !componentAllow.includes(token.component)) {
      return {
        ok: false,
        code: 'INVALID_COMPONENT',
        message: `「${token.text}」的句子成分取值非法：${token.component}`,
      };
    }
    // 词性：只查词性集合（与上一行完全独立）
    if (token.pos !== null && !posAllow.includes(token.pos)) {
      return {
        ok: false,
        code: 'INVALID_POS',
        message: `「${token.text}」的词性取值非法：${token.pos}`,
      };
    }
  }

  return { ok: true };
}

/** 成分计数。`none` = 尚未标注成分的 token 数。 */
export function countComponents(
  tokens: SentenceTokenDto[],
): Record<SentenceComponent, number> & { none: number } {
  const out = {
    S: 0,
    V: 0,
    O: 0,
    C: 0,
    ADVERBIAL: 0,
    none: 0,
  } as Record<SentenceComponent, number> & { none: number };

  for (const token of tokens) {
    if (token.component === null) out.none += 1;
    else out[token.component] += 1;
  }
  return out;
}

/** 词性计数。`none` = 尚未标注词性的 token 数。 */
export function countPos(
  tokens: SentenceTokenDto[],
): Record<PartOfSpeech, number> & { none: number } {
  const out = {
    NOUN: 0,
    VERB: 0,
    ADJ: 0,
    ADV: 0,
    PREP: 0,
    PRON: 0,
    OTHER: 0,
    none: 0,
  } as Record<PartOfSpeech, number> & { none: number };

  for (const token of tokens) {
    if (token.pos === null) out.none += 1;
    else out[token.pos] += 1;
  }
  return out;
}

/** 标注进度（成分与词性分别统计，不互相推导）。 */
export function annotationProgress(tokens: SentenceTokenDto[]): {
  total: number;
  componentAnnotated: number;
  posAnnotated: number;
  ratio: number;
} {
  const total = tokens.length;
  if (total === 0) {
    return { total: 0, componentAnnotated: 0, posAnnotated: 0, ratio: 0 };
  }
  const componentAnnotated = tokens.filter((token) => token.component !== null).length;
  const posAnnotated = tokens.filter((token) => token.pos !== null).length;
  return {
    total,
    componentAnnotated,
    posAnnotated,
    ratio: Math.round((componentAnnotated / total) * 100) / 100,
  };
}

/** 是否已经标出最小可判定结构（至少一个 S 与一个 V）。 */
export function hasCoreComponents(tokens: SentenceTokenDto[]): boolean {
  const counts = countComponents(tokens);
  return counts.S > 0 && counts.V > 0;
}

/**
 * 连续同成分合并成「语块」，用于详情的彩色分段展示。
 * 只按 `component` 合并，**不参考** `pos`。
 */
export function groupByComponent(
  tokens: SentenceTokenDto[],
): { component: SentenceComponent | null; text: string }[] {
  const groups: { component: SentenceComponent | null; text: string }[] = [];
  for (const token of tokens) {
    const last = groups[groups.length - 1];
    if (last && last.component === token.component) {
      last.text = `${last.text} ${token.text}`;
    } else {
      groups.push({ component: token.component, text: token.text });
    }
  }
  return groups;
}

/** 句子分析页的列表级统计（不涉及数据库）。 */
export function summarizeSentenceRows(
  rows: { tokens: SentenceTokenDto[]; isCorrect: boolean }[],
): {
  total: number;
  correct: number;
  error: number;
  componentCounts: Record<SentenceComponent, number>;
  unannotatedTokens: number;
} {
  const componentCounts: Record<SentenceComponent, number> = {
    S: 0,
    V: 0,
    O: 0,
    C: 0,
    ADVERBIAL: 0,
  };
  let unannotatedTokens = 0;
  let correct = 0;

  for (const row of rows) {
    if (row.isCorrect) correct += 1;
    for (const token of row.tokens) {
      if (token.component === null) unannotatedTokens += 1;
      else componentCounts[token.component] += 1;
    }
  }

  return {
    total: rows.length,
    correct,
    error: rows.length - correct,
    componentCounts,
    unannotatedTokens,
  };
}
