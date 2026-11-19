/**
 * 词汇导入 —— 纯函数（v2.3 Phase 1）。
 *
 * 只做「文本 → 预览」：不写库、不读文件系统、不依赖运行时环境。
 * 入库由 Server Action 在用户确认预览结果后执行，保证「先看差异再写库」。
 *
 * 词条身份：`language + normalizedLemma + pos + senseKey`。
 * 同形异义（bank:noun:financial vs bank:noun:riverbank）通过 senseKey 区分，
 * 绝不用「单词」作为唯一键。
 */

import {
  VOCAB_IMPORT_MAX_ROWS,
  VOCAB_IMPORT_PREVIEW_LIMIT,
} from '../constants';
import type { NormalizedVocabItem, VocabImportPreview, VocabImportRow, VocabImportRowStatus } from '../types';

export type VocabImportFormat = 'CSV' | 'TSV' | 'JSON';

/** 导入时可识别的字段（顺序即优先级，用于同义表头自动映射）。 */
export const VOCAB_IMPORT_FIELDS = [
  'lemma',
  'pos',
  'senseKey',
  'definitionZh',
  'definitionEn',
  'phoneticUk',
  'phoneticUs',
  'example',
  'collocation',
  'tags',
  'sourceRef',
] as const;
export type VocabImportField = (typeof VOCAB_IMPORT_FIELDS)[number];

export const VOCAB_IMPORT_FIELD_LABEL_ZH: Record<VocabImportField, string> = {
  lemma: '词条（lemma）',
  pos: '词性（pos）',
  senseKey: '义项键（senseKey）',
  definitionZh: '中文释义',
  definitionEn: '英文释义',
  phoneticUk: '英式音标',
  phoneticUs: '美式音标',
  example: '例句',
  collocation: '搭配',
  tags: '标签',
  sourceRef: '来源引用（sourceRef）',
};

/** 表头别名 → 字段。比较前统一小写并去掉空格/下划线/连字符。 */
const HEADER_ALIASES: Record<VocabImportField, string[]> = {
  lemma: ['lemma', 'word', 'headword', 'term', '单词', '词条'],
  pos: ['pos', 'partofspeech', 'part_of_speech', '词性'],
  senseKey: ['sensekey', 'sense', '义项', '义项键'],
  definitionZh: ['definitionzh', 'meaningzh', 'meaning', 'translation', 'cn', '释义', '中文释义'],
  definitionEn: ['definitionen', 'definition', 'english', 'en', '英文释义'],
  phoneticUk: ['phoneticuk', 'phonetic', 'uk', '英音', '英式音标'],
  phoneticUs: ['phoneticus', 'us', '美音', '美式音标'],
  example: ['example', 'examplesentence', 'sentence', '例句'],
  collocation: ['collocation', 'collocations', '搭配'],
  tags: ['tags', 'tag', '标签'],
  sourceRef: ['sourceref', 'externalid', 'id', '来源引用'],
};

/** 常见词性写法归一（只做显式映射，不做词性推断）。 */
const POS_CANONICAL: Record<string, string> = {
  n: 'n',
  noun: 'n',
  v: 'v',
  verb: 'v',
  adj: 'adj',
  adjective: 'adj',
  adv: 'adv',
  adverb: 'adv',
  prep: 'prep',
  preposition: 'prep',
  pron: 'pron',
  pronoun: 'pron',
  conj: 'conj',
  conjunction: 'conj',
  num: 'num',
  numeral: 'num',
  art: 'art',
  article: 'art',
  phrase: 'phrase',
  phr: 'phrase',
};

function normHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-()（）]/g, '');
}

/** 词条归一：小写、合并空白、去掉首尾引号。不改变拼写（不做词形还原）。 */
export function normalizeLemma(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** 词性归一：识别常见缩写，未知值原样小写保留（不猜测）。 */
export function canonicalPos(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = raw.trim().toLowerCase().replace(/[.,;]/g, '');
  if (!cleaned) return '';
  return POS_CANONICAL[cleaned] ?? cleaned;
}

/** 词条身份键（与数据库唯一约束同构）。 */
export function vocabularyKey(input: {
  normalizedLemma: string;
  pos: string;
  senseKey: string;
  language?: string;
}): string {
  const language = (input.language ?? 'en').toLowerCase();
  return `${language}|${input.normalizedLemma}|${input.pos}|${input.senseKey}`;
}

/** 自动映射表头；未识别的列不猜。 */
export function mapHeaders(headers: string[]): Record<string, VocabImportField | null> {
  const out: Record<string, VocabImportField | null> = {};
  const used = new Set<VocabImportField>();
  for (const header of headers) {
    const key = normHeader(header);
    let matched: VocabImportField | null = null;
    for (const field of VOCAB_IMPORT_FIELDS) {
      if (used.has(field)) continue;
      if (HEADER_ALIASES[field].includes(key)) {
        matched = field;
        break;
      }
    }
    out[header] = matched;
    if (matched) used.add(matched);
  }
  return out;
}

export function detectVocabImportFormat(fileName: string, text: string): VocabImportFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return 'JSON';
  if (lower.endsWith('.tsv')) return 'TSV';
  if (lower.endsWith('.csv')) return 'CSV';
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.startsWith('{') || firstLine.startsWith('[')) return 'JSON';
  return firstLine.includes('\t') ? 'TSV' : 'CSV';
}

/** 解析分隔符文本；支持双引号包裹、`""` 转义与字段内换行。 */
export function parseDelimited(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((columns) => columns.some((value) => value.trim() !== ''));
}

/** 从 TypeWords 导出的 `Word` 对象提取字段（只读取存在字段，不补造）。 */
function fromTypeWordsWord(word: Record<string, unknown>): Record<string, string> {
  const trans = Array.isArray(word.trans) ? (word.trans as Array<Record<string, unknown>>) : [];
  const sentences = Array.isArray(word.sentences)
    ? (word.sentences as Array<Record<string, unknown>>)
    : [];
  const phrases = Array.isArray(word.phrases) ? (word.phrases as Array<Record<string, unknown>>) : [];
  const pos = trans[0]?.pos;
  const cn = trans[0]?.cn;
  return {
    lemma: typeof word.word === 'string' ? word.word : '',
    pos: typeof pos === 'string' ? pos : '',
    definitionZh: typeof cn === 'string' ? cn : '',
    phoneticUk: typeof word.phonetic0 === 'string' ? word.phonetic0 : '',
    phoneticUs: typeof word.phonetic1 === 'string' ? word.phonetic1 : '',
    example: typeof sentences[0]?.c === 'string' ? (sentences[0].c as string) : '',
    collocation: typeof phrases[0]?.c === 'string' ? (phrases[0].c as string) : '',
  };
}

/** JSON 词库的已支持形态（其余形态报错，不做静默猜测）。 */
export interface JsonWordsResult {
  records: Array<Record<string, string>>;
  headers: string[];
  shape: string;
}

export function extractJsonWords(text: string): JsonWordsResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 解析失败：${(error as Error).message}`);
  }

  const fromWordArray = (words: unknown[]): JsonWordsResult => {
    const records = words.map((word) =>
      word && typeof word === 'object' && 'word' in (word as Record<string, unknown>)
        ? fromTypeWordsWord(word as Record<string, unknown>)
        : stringifyRecord(word as Record<string, unknown>),
    );
    return { records, headers: Object.keys(records[0] ?? {}), shape: 'array' };
  };

  const stringifyRecord = (record: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(record ?? {})) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') out[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
      else out[key] = JSON.stringify(value);
    }
    return out;
  };

  if (Array.isArray(data)) {
    const result = fromWordArray(data);
    if (data.every((row) => row && typeof row === 'object' && !('word' in (row as object)))) {
      const records = data.map((row) => stringifyRecord(row as Record<string, unknown>));
      const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
      return { records, headers, shape: 'object-array' };
    }
    return result;
  }

  if (data && typeof data === 'object') {
    const root = data as Record<string, unknown>;
    if (Array.isArray(root.words)) return { ...fromWordArray(root.words), shape: 'words' };
    const val = root.val as Record<string, unknown> | undefined;
    if (val && Array.isArray(val.words)) return { ...fromWordArray(val.words), shape: 'val.words' };
    const candidates: Array<{ store: unknown; shape: string }> = [
      { store: val?.word, shape: 'typewords.dict' },
      {
        store:
          val && typeof val.dict === 'object' && val.dict
            ? (val.dict as Record<string, unknown>).val &&
              typeof (val.dict as Record<string, unknown>).val === 'object'
              ? ((val.dict as Record<string, unknown>).val as Record<string, unknown>).word
              : undefined
            : undefined,
        shape: 'typewords.backup',
      },
    ];
    for (const candidate of candidates) {
      const wordStore = candidate.store as Record<string, unknown> | undefined;
      const bookList = wordStore && Array.isArray(wordStore.bookList) ? wordStore.bookList : null;
      if (bookList) {
        const words = bookList.flatMap((book) => {
          const entry = book as Record<string, unknown>;
          return Array.isArray(entry.words) ? entry.words : [];
        });
        return { ...fromWordArray(words), shape: candidate.shape };
      }
    }
  }

  throw new Error('无法识别的 JSON 结构：支持数组、{ words: [] }、{ val: { words: [] } } 或 TypeWords 备份');
}

export interface BuildPreviewInput {
  fileName: string;
  text: string;
  /** 库中已存在的词条身份 + 现有中文释义，用于区分 EXISTS / CONFLICT。 */
  existing?: Map<string, string | null>;
  /** 同一文件内允许的最大行数，默认取常量。 */
  maxRows?: number;
  /** 返回行数上限；确认导入时传 Infinity 以拿到全部行（预览仍用默认截断）。 */
  previewLimit?: number;
}

/** 生成导入预览（纯函数，不写库）。 */
export function buildImportPreview(input: BuildPreviewInput): VocabImportPreview {
  const format = detectVocabImportFormat(input.fileName, input.text);
  const blockingErrors: string[] = [];
  const maxRows = input.maxRows ?? VOCAB_IMPORT_MAX_ROWS;

  let headers: string[] = [];
  let rawRecords: Array<Record<string, string>> = [];
  let lineNumbers: number[] = [];

  if (format === 'JSON') {
    const parsed = extractJsonWords(input.text);
    headers = parsed.headers;
    rawRecords = parsed.records;
    lineNumbers = parsed.records.map((_, index) => index + 1);
  } else {
    const rows = parseDelimited(input.text, format === 'TSV' ? '\t' : ',');
    if (rows.length === 0) {
      return emptyPreview(format, ['文件为空或没有可解析的数据行。']);
    }
    headers = (rows[0] ?? []).map((header, index) => header.trim() || `第 ${index + 1} 列`);
    rawRecords = rows.slice(1).map((columns) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = columns[index] ?? '';
      });
      return record;
    });
    lineNumbers = rows.slice(1).map((_, index) => index + 2);
  }

  if (rawRecords.length > maxRows) {
    blockingErrors.push(
      `共 ${rawRecords.length} 行，超过单次导入上限 ${maxRows} 行；请拆分文件后再导入。`,
    );
  }

  const headerMapping = mapHeaders(headers);
  const mappedFields = new Set(Object.values(headerMapping).filter(Boolean));
  if (!mappedFields.has('lemma')) {
    blockingErrors.push('未识别到词条列：请把表头命名为 lemma / word / 单词 之一。');
  }

  const mapping: Record<string, string> = {};
  for (const [header, field] of Object.entries(headerMapping)) {
    mapping[header] = field ?? '未映射';
  }

  const existing = input.existing ?? new Map<string, string | null>();
  const seen = new Map<string, number>();
  const counts: Record<VocabImportRowStatus, number> = {
    NEW: 0,
    DUPLICATE_IN_FILE: 0,
    EXISTS: 0,
    CONFLICT: 0,
    INVALID: 0,
  };
  const rowsOut: VocabImportRow[] = [];

  rawRecords.forEach((record, index) => {
    const line = lineNumbers[index] ?? index + 1;
    const valueOf = (field: VocabImportField): string => {
      const header = Object.keys(headerMapping).find((key) => headerMapping[key] === field);
      return header ? (record[header] ?? '').trim() : '';
    };

    const lemma = valueOf('lemma');
    const messages: string[] = [];
    let status: VocabImportRowStatus = 'NEW';
    let item: NormalizedVocabItem | null = null;

    if (!lemma) {
      status = 'INVALID';
      messages.push('词条为空');
    } else {
      const normalizedLemma = normalizeLemma(lemma);
      const pos = canonicalPos(valueOf('pos'));
      const senseKey = valueOf('senseKey') || 'default';
      const definitionZh = valueOf('definitionZh') || null;
      const definitionEn = valueOf('definitionEn') || null;
      item = {
        lemma: lemma.trim(),
        normalizedLemma,
        pos,
        senseKey,
        definitionZh,
        definitionEn,
        phoneticUk: valueOf('phoneticUk') || null,
        phoneticUs: valueOf('phoneticUs') || null,
        examples: splitList(valueOf('example')),
        collocations: splitList(valueOf('collocation')),
        tags: splitList(valueOf('tags')),
        sourceRef: valueOf('sourceRef') || null,
      };

      if (normalizedLemma.length > 120) {
        status = 'INVALID';
        messages.push('词条超过 120 个字符');
      } else if (!definitionZh && !definitionEn) {
        messages.push('缺少释义：可导入，但不会进入练习候选');
      }

      if (status === 'NEW') {
        const key = vocabularyKey({ normalizedLemma, pos, senseKey });
        const firstLine = seen.get(key);
        if (firstLine !== undefined) {
          status = 'DUPLICATE_IN_FILE';
          messages.push(`与第 ${firstLine} 行重复（同一 lemma + pos + senseKey）`);
        } else {
          seen.set(key, line);
          if (existing.has(key)) {
            const current = existing.get(key) ?? null;
            const same = (current ?? '') === (definitionZh ?? '');
            status = same ? 'EXISTS' : 'CONFLICT';
            messages.push(
              same
                ? '库中已存在相同词条，跳过'
                : `库中已存在同键词条但释义不同（库：${current ?? '空'}）；确认后以文件为准更新`,
            );
          }
        }
      }
    }

    counts[status] += 1;
    rowsOut.push({ line, status, item, raw: record, messages });
  });

  const limit = input.previewLimit ?? VOCAB_IMPORT_PREVIEW_LIMIT;
  const truncated = rowsOut.length > limit;

  return {
    format,
    headers,
    mapping,
    total: rawRecords.length,
    counts,
    rows: truncated ? rowsOut.slice(0, limit) : rowsOut,
    truncated,
    blockingErrors,
  };
}

function emptyPreview(format: VocabImportFormat, errors: string[]): VocabImportPreview {
  return {
    format,
    headers: [],
    mapping: {},
    total: 0,
    counts: { NEW: 0, DUPLICATE_IN_FILE: 0, EXISTS: 0, CONFLICT: 0, INVALID: 0 },
    rows: [],
    truncated: false,
    blockingErrors: errors,
  };
}

/** 多值字段：英文逗号或竖线分隔；保留原顺序。 */
function splitList(value: string): string[] {
  if (!value) return [];
  return value
    .split(/[|;；]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
