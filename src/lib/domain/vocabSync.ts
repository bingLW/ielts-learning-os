/**
 * TypeWords 文件交换 —— 纯函数（v2.3 Phase 2）。
 *
 * 只处理 JSON 结构：解析其备份、生成兼容备份、计算重叠时长。
 * 不做 DOM / IndexedDB / 网络访问 —— 那些属于「桥接」（L2，默认关闭）。
 *
 * 固定 commit 的事实约束：
 * - 统计只有 `Statistics{startDate, spend, total, new, review, wrong, segments, sessionRole}`；
 * - `spend` 与 `segments` 都是毫秒；`startDate` 是毫秒时间戳；
 * - 没有逐词尝试日志 → 只能生成 SUMMARY_ONLY 会话。
 */

import {
  TYPEWORDS_DICT_VERSION,
  TYPEWORDS_EXPORT_VERSION,
  TYPEWORDS_SETTING_VERSION,
} from '../constants';
import type { NormalizedVocabItem } from '../types';

/** TypeWords 的 Statistics（仅保留 OS 用到的字段）。 */
export interface TypeWordsStatistic {
  startDate: number;
  spend: number;
  total: number;
  new: number;
  review: number;
  wrong: number;
  segments?: Array<[number, number]>;
  sessionRole?: 'single' | 'start' | 'middle' | 'end';
  title?: string;
}

export interface ParsedSession {
  /** 稳定 id（由内容派生，重复导入同一条统计不会产生新会话）。 */
  canonicalKey: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  total: number;
  newWords: number;
  reviewWords: number;
  wrong: number;
  segments: Array<[number, number]>;
  sourceTitle: string | null;
}

export interface ParsedTypeWordsBackup {
  formatVersion: number | null;
  dictNames: string[];
  wordCount: number;
  words: NormalizedVocabItem[];
  sessions: ParsedSession[];
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/** 解析 TypeWords 备份 JSON（data.json 或导出的 .json）。 */
export function parseTypeWordsBackup(text: string): ParsedTypeWordsBackup {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new Error(`备份不是合法 JSON：${(error as Error).message}`);
  }
  if (!isObject(root)) throw new Error('备份根节点不是对象');

  const warnings: string[] = [];
  const formatVersion = typeof root.version === 'number' ? root.version : null;
  if (formatVersion !== null && formatVersion !== TYPEWORDS_EXPORT_VERSION) {
    warnings.push(
      `备份版本 ${formatVersion} 与固定审计版本 ${TYPEWORDS_EXPORT_VERSION} 不同；字段按已知子集解析，未知字段忽略。`,
    );
  }

  const val = isObject(root.val) ? root.val : null;
  const dictSave = val && isObject(val.dict) ? val.dict : null;
  const dictState = dictSave && isObject(dictSave.val) ? dictSave.val : null;
  if (!dictState) {
    throw new Error('备份缺少 val.dict.val：这不是 TypeWords 用户数据备份');
  }

  const wordStore = isObject(dictState.word) ? dictState.word : null;
  const bookList = wordStore && Array.isArray(wordStore.bookList) ? wordStore.bookList : [];
  if (bookList.length === 0) {
    warnings.push('备份里没有单词词典（bookList 为空）。');
  }

  const dictNames: string[] = [];
  const words: NormalizedVocabItem[] = [];
  const sessions: ParsedSession[] = [];

  for (const book of bookList) {
    if (!isObject(book)) continue;
    const name = typeof book.name === 'string' ? book.name : '(未命名词典)';
    dictNames.push(name);

    if (Array.isArray(book.words)) {
      for (const word of book.words) {
        const item = normalizeTypeWordsWord(word);
        if (item) words.push(item);
      }
    }

    if (Array.isArray(book.statistics)) {
      for (const stat of book.statistics) {
        const session = toSession(stat, name);
        if (session) sessions.push(session);
        else warnings.push(`词典「${name}」有一条统计缺少有效时间，已跳过。`);
      }
    }
  }

  // 去重（同一统计可能因多天记录出现在同一词典）
  const seenSessions = new Set<string>();
  const uniqueSessions = sessions.filter((session) => {
    if (seenSessions.has(session.canonicalKey)) return false;
    seenSessions.add(session.canonicalKey);
    return true;
  });

  // TypeWords 导出时对内置词典（非 custom、非 system）会清空 words，只保留统计；
  // 这不是损坏，而是对方的有意裁剪，需要向用户说明为什么词条为 0。
  const truncatedBooks = bookList.filter(
    (book) => isObject(book) && Number(book.length) > 0 && Array.isArray(book.words) && book.words.length === 0,
  );
  if (truncatedBooks.length > 0 && words.length === 0) {
    warnings.push('备份未包含词条正文（TypeWords 导出时裁掉了内置词典的单词），本次只导入会话统计。');
  }

  return {
    formatVersion,
    dictNames,
    wordCount: words.length,
    words,
    sessions: uniqueSessions,
    warnings,
  };
}

function normalizeTypeWordsWord(value: unknown): NormalizedVocabItem | null {
  if (!isObject(value)) return null;
  const lemma = typeof value.word === 'string' ? value.word.trim() : '';
  if (!lemma) return null;

  const trans = Array.isArray(value.trans) ? value.trans.filter(isObject) : [];
  const firstTrans = trans[0];
  const pos = typeof firstTrans?.pos === 'string' ? firstTrans.pos.toLowerCase().trim() : '';
  const definitionZh = typeof firstTrans?.cn === 'string' ? firstTrans.cn.trim() : null;
  const sentences = Array.isArray(value.sentences) ? value.sentences.filter(isObject) : [];
  const phrases = Array.isArray(value.phrases) ? value.phrases.filter(isObject) : [];

  return {
    lemma,
    normalizedLemma: lemma.replace(/\s+/g, ' ').toLowerCase(),
    pos,
    senseKey: 'default',
    definitionZh: definitionZh || null,
    definitionEn: null,
    phoneticUk: typeof value.phonetic0 === 'string' ? value.phonetic0 : null,
    phoneticUs: typeof value.phonetic1 === 'string' ? value.phonetic1 : null,
    examples: sentences
      .map((sentence) => (typeof sentence.c === 'string' ? sentence.c : ''))
      .filter(Boolean),
    collocations: phrases
      .map((phrase) => (typeof phrase.c === 'string' ? phrase.c : ''))
      .filter(Boolean),
    tags: [],
    sourceRef: typeof value.id === 'string' ? value.id : null,
  };
}

function toSession(value: unknown, dictName: string): ParsedSession | null {
  if (!isObject(value) || typeof value.startDate !== 'number') return null;
  const segments = Array.isArray(value.segments)
    ? (value.segments as unknown[])
        .filter((segment): segment is [number, number] =>
          Array.isArray(segment) &&
          segment.length === 2 &&
          typeof segment[0] === 'number' &&
          typeof segment[1] === 'number' &&
          segment[1] >= segment[0],
        )
        .map(([start, end]) => [start, end] as [number, number])
    : [];

  const startMs = segments.length > 0 ? Math.min(...segments.map(([start]) => start)) : value.startDate;
  const endMs =
    segments.length > 0
      ? Math.max(...segments.map(([, end]) => end))
      : value.startDate + Math.max(0, Number(value.spend) || 0);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const durationMs =
    segments.length > 0
      ? segments.reduce((sum, [start, end]) => sum + (end - start), 0)
      : Math.max(0, Number(value.spend) || 0);
  const seconds = Math.max(1, Math.round(durationMs / 1000));

  const role = typeof value.sessionRole === 'string' ? value.sessionRole : 'single';
  const canonicalKey = [
    'typewords',
    Math.round(startMs),
    Math.round(endMs),
    role,
    seconds,
    Number(value.total) || 0,
    Number(value.wrong) || 0,
  ].join(':');

  return {
    canonicalKey,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    durationSeconds: seconds,
    total: Math.max(0, Math.round(Number(value.total) || 0)),
    newWords: Math.max(0, Math.round(Number(value.new) || 0)),
    reviewWords: Math.max(0, Math.round(Number(value.review) || 0)),
    wrong: Math.max(0, Math.round(Number(value.wrong) || 0)),
    segments,
    sourceTitle: typeof value.title === 'string' ? value.title : dictName,
  };
}

export interface Interval {
  startMs: number;
  endMs: number;
}

/** 与既有区间重叠的秒数（同一份时长只计一次）。 */
export function overlapSeconds(interval: Interval, existing: Interval[]): number {
  // 先把已有区间合并成不重叠的并集，否则两个相互重叠的既有区间会被算两次。
  const clipped = existing
    .map((other) => ({
      start: Math.max(interval.startMs, other.startMs),
      end: Math.min(interval.endMs, other.endMs),
    }))
    .filter((part) => part.end > part.start)
    .sort((a, b) => a.start - b.start);

  let overlapMs = 0;
  let cursorStart = -Infinity;
  let cursorEnd = -Infinity;
  for (const part of clipped) {
    if (part.start > cursorEnd) {
      if (cursorEnd > cursorStart) overlapMs += cursorEnd - cursorStart;
      cursorStart = part.start;
      cursorEnd = part.end;
    } else {
      cursorEnd = Math.max(cursorEnd, part.end);
    }
  }
  if (cursorEnd > cursorStart) overlapMs += cursorEnd - cursorStart;
  return Math.round(overlapMs / 1000);
}

/** 有效秒数 = 总时长 − 与既有会话/学习记录重叠的时长。 */
export function effectiveSeconds(interval: Interval, existing: Interval[]): number {
  const total = Math.max(0, Math.round((interval.endMs - interval.startMs) / 1000));
  return Math.max(0, total - overlapSeconds(interval, existing));
}

/** 从备份会话构建 OS 的会话载荷（不做时间重叠处理，交给 action 与数据库比较）。 */
export function sessionInterval(session: ParsedSession): Interval {
  return { startMs: Date.parse(session.startedAt), endMs: Date.parse(session.endedAt) };
}

export interface TypeWordsExportWord {
  id: string;
  word: string;
  phonetic0: string;
  phonetic1: string;
  trans: Array<{ pos: string; cn: string }>;
  sentences: Array<{ c: string; cn: string }>;
  phrases: Array<{ c: string; cn: string }>;
  synos: [];
  relWords: { root: string; rels: [] };
  etymology: [];
  custom: true;
}

export interface TypeWordsExportDeckInput {
  deckId: string;
  title: string;
  description?: string;
  words: NormalizedVocabItem[];
}

/**
 * 生成 TypeWords 兼容的备份 JSON。
 *
 * ⚠️ 官方导入是「整库覆盖」：调用方必须先让用户导出原备份或使用独立浏览器配置文件。
 * 这里只生成单词典包，不包含用户原有词典。
 */
export function buildTypeWordsBackup(
  input: TypeWordsExportDeckInput,
): Record<string, unknown> {
  const words: TypeWordsExportWord[] = input.words.map((item, index) => ({
    id: `${input.deckId}-${index + 1}`,
    word: item.lemma,
    phonetic0: item.phoneticUk ?? '',
    phonetic1: item.phoneticUs ?? '',
    trans: item.definitionZh || item.definitionEn
      ? [{ pos: item.pos, cn: item.definitionZh ?? item.definitionEn ?? '' }]
      : [],
    sentences: item.examples.map((example) => ({ c: example, cn: '' })),
    phrases: item.collocations.map((collocation) => ({ c: collocation, cn: '' })),
    synos: [],
    relWords: { root: '', rels: [] },
    etymology: [],
    custom: true,
  }));

  const dict = {
    id: input.deckId,
    name: input.title,
    description: input.description ?? '由 IELTS Learning OS 生成；导入会覆盖 TypeWords 现有词典',
    url: '',
    length: words.length,
    category: 'custom',
    tags: ['IELTS Learning OS'],
    translateLanguage: 'zh-CN',
    type: 'word',
    version: 1,
    language: 'en',
    lastLearnIndex: 0,
    perDayStudyNumber: 20,
    words,
    articles: [],
    statistics: [],
    custom: true,
    system: false,
    sourceId: '',
    complete: false,
    createdBy: 'IELTS Learning OS',
    enName: '',
    category_id: null,
    is_default: false,
    update: false,
    cover: '',
    sync: false,
  };

  return {
    version: TYPEWORDS_EXPORT_VERSION,
    val: {
      dict: {
        version: TYPEWORDS_DICT_VERSION,
        val: {
          simpleWords: [],
          load: true,
          word: { studyIndex: 0, bookList: [dict] },
          article: { bookList: [], studyIndex: 0 },
          dictListVersion: 1,
          fsrsData: {},
          noteData: {},
          _ignoreWatch: false,
        },
      },
      setting: { version: TYPEWORDS_SETTING_VERSION, val: {} },
      PracticeSaveWord: { version: 2, val: {} },
      PracticeSaveArticle: { version: 1, val: {} },
    },
  };
}
