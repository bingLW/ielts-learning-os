/**
 * MIME 魔数嗅探 + 三方一致性判定（架构 §6.1）。
 *
 * 为什么不能只信 `File.type` 与扩展名：浏览器给的 MIME 完全由客户端决定，
 * 把 `.pdf` 改名成 `.txt`、或用 ZIP 冒充 PDF 都是零成本攻击。这里的判定顺序是
 *
 *   ① 扩展名必须在材料白名单内（否则 `UNSUPPORTED_FORMAT`）
 *   ② 字节内容必须嗅探出**确定的**格式（否则 `MAGIC_MISMATCH`）
 *   ③ 嗅探结果必须与扩展名兼容（`.pdf` 实为 ZIP → 拒绝，且**不会**去解析任意 zip）
 *   ④ 嗅探结果必须与声明的 MIME 兼容（声明 `image/png` 的 PDF → 拒绝）
 *
 * 三方全过才放行。`TXT` 与 `MARKDOWN` 共用「可解码 UTF-8 文本」判据，
 * 最终格式由扩展名决定（`.md` 走 Markdown 解析器）。
 */

import {
  extensionFromFileName,
  isAllowedMaterialExtension,
  normalizeMaterialExtension,
} from '@/lib/storage';
import { listZipEntryNames } from './zip';

export interface MagicCheckInput {
  bytes: Buffer;
  declaredMime: string | null;
  fileName: string;
}

export type MagicFormat = 'PDF' | 'DOCX' | 'HTML' | 'TXT' | 'MARKDOWN' | 'AUDIO' | 'VIDEO';

export type MagicVerdict =
  | { ok: true; format: MagicFormat }
  | { ok: false; code: 'MAGIC_MISMATCH' | 'UNSUPPORTED_FORMAT' | 'EMPTY_FILE'; message: string };

/** PDF 规范允许前置垃圾字节，因此在前 1024 字节内查找 `%PDF-`。 */
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const PDF_MAGIC_WINDOW = 1024;
const HTML_SNIFF_WINDOW = 4096;

const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac'] as const;
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'avi', 'mkv'] as const;

/** DOCX 中央目录必须同时含这两个条目（只认 OOXML 文档，不放行任意 zip）。 */
const DOCX_REQUIRED_ENTRIES = ['[Content_Types].xml', 'word/document.xml'] as const;

/** 嗅探出的「内容形态」。`ZIP` 表示是合法 zip 但不是 docx。 */
type DetectedKind = 'PDF' | 'DOCX' | 'ZIP' | 'HTML' | 'TEXT' | 'AUDIO' | 'VIDEO' | 'UNKNOWN';

const MIME_ALLOWLIST: Record<MagicFormat, readonly string[]> = {
  PDF: ['application/pdf'],
  DOCX: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/x-zip-compressed',
  ],
  HTML: ['text/html', 'application/xhtml+xml'],
  TXT: ['text/plain'],
  MARKDOWN: ['text/markdown', 'text/x-markdown', 'text/plain'],
  AUDIO: ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/aac'],
  VIDEO: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
};

/** 扩展名 → 最终格式（`null` 表示不支持）。 */
function formatFromExtension(extension: string): MagicFormat | null {
  switch (normalizeMaterialExtension(extension)) {
    case 'pdf':
      return 'PDF';
    case 'docx':
      return 'DOCX';
    case 'html':
    case 'htm':
      return 'HTML';
    case 'txt':
      return 'TXT';
    case 'md':
    case 'markdown':
      return 'MARKDOWN';
    default:
      return null;
  }
}

/** 内容形态 → 允许的扩展名格式（三方一致性的第二边）。 */
const EXTENSION_COMPATIBILITY: Record<DetectedKind, readonly MagicFormat[]> = {
  PDF: ['PDF'],
  DOCX: ['DOCX'],
  ZIP: [],
  HTML: ['HTML', 'MARKDOWN'],
  TEXT: ['TXT', 'MARKDOWN'],
  AUDIO: ['AUDIO'],
  VIDEO: ['VIDEO'],
  UNKNOWN: [],
};

/** 内容形态 → 允许的 MIME 前缀（三方一致性的第三边）。 */
const GENERIC_MIMES = ['', 'application/octet-stream', 'binary/octet-stream'];

function mimeCompatible(kind: DetectedKind, declaredMime: string | null): boolean {
  const mime = (declaredMime ?? '').split(';')[0].trim().toLowerCase();
  if (GENERIC_MIMES.includes(mime)) return true;
  switch (kind) {
    case 'PDF':
      return mime === 'application/pdf';
    case 'DOCX':
      return mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || mime === 'application/zip'
        || mime === 'application/x-zip-compressed';
    case 'HTML':
      return mime === 'text/html' || mime === 'application/xhtml+xml';
    case 'TEXT':
      return mime.startsWith('text/');
    case 'AUDIO':
      return mime.startsWith('audio/');
    case 'VIDEO':
      return mime.startsWith('video/');
    default:
      return false;
  }
}

function detectPdf(bytes: Buffer): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, PDF_MAGIC_WINDOW));
  return window.indexOf(PDF_MAGIC) >= 0;
}

function detectZipKind(bytes: Buffer): DetectedKind | null {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return null;
  const names = listZipEntryNames(bytes);
  if (!names) return 'ZIP';
  const hasAll = DOCX_REQUIRED_ENTRIES.every((entry) => names.includes(entry));
  return hasAll ? 'DOCX' : 'ZIP';
}

function detectHtml(bytes: Buffer): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, HTML_SNIFF_WINDOW)).toString('utf8');
  const normalized = window.replace(/^\uFEFF/, '').trim().toLowerCase();
  return (
    normalized.startsWith('<!doctype html') ||
    normalized.startsWith('<html') ||
    normalized.startsWith('<head') ||
    normalized.startsWith('<body')
  );
}

export interface TextSniffResult {
  ok: boolean;
  /** 控制字符占比（0–1），用于诊断与单测。 */
  controlRatio: number;
}

/** UTF-8 可解码 + 无 NUL + 控制字符占比 < 1%。 */
export function sniffPlainText(bytes: Buffer): TextSniffResult {
  if (bytes.includes(0)) return { ok: false, controlRatio: 1 };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, controlRatio: 1 };
  }
  let control = 0;
  for (const byte of bytes) {
    // 允许 TAB / LF / CR；其余 C0 控制符与 DEL 都算"脏"
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) control += 1;
    else if (byte === 0x7f) control += 1;
  }
  const ratio = bytes.length === 0 ? 0 : control / bytes.length;
  return { ok: ratio < 0.01, controlRatio: ratio };
}

function detectAudioOrVideo(bytes: Buffer): DetectedKind | null {
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('latin1') === 'ID3') return 'AUDIO';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'AUDIO';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WAVE'
  ) {
    return 'AUDIO';
  }
  // ISO BMFF：offset 4 起是 `ftyp`；用 brand 判断音频还是视频容器
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1').toLowerCase();
    return brand.startsWith('m4a') || brand.startsWith('m4b') || brand === 'mp42' ? 'AUDIO' : 'VIDEO';
  }
  return null;
}

/** 内容形态判定（纯字节，不看扩展名）。 */
export function detectContentKind(bytes: Buffer): DetectedKind {
  if (detectPdf(bytes)) return 'PDF';
  const zipKind = detectZipKind(bytes);
  if (zipKind) return zipKind;
  const media = detectAudioOrVideo(bytes);
  if (media) return media;
  if (detectHtml(bytes)) return 'HTML';
  if (sniffPlainText(bytes).ok) return 'TEXT';
  return 'UNKNOWN';
}

const AUDIO_VIDEO_HINT = '暂不支持音频/视频材料导入（P1 能力）';

/**
 * 三方一致性判定。返回**最终格式**（TXT / MARKDOWN 已按扩展名区分）。
 */
export function sniffFormat(input: MagicCheckInput): MagicVerdict {
  const { bytes, declaredMime, fileName } = input;
  if (bytes.byteLength === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '文件是空的，没有可提取的内容' };
  }

  const extension = extensionFromFileName(fileName);
  const declaredExtension = normalizeMaterialExtension(extension);
  const isMediaExtension = (AUDIO_EXTENSIONS as readonly string[])
    .concat(VIDEO_EXTENSIONS)
    .includes(declaredExtension);
  const isMediaContent =
    detectAudioOrVideo(bytes) !== null;

  if (!isAllowedMaterialExtension(declaredExtension)) {
    if (isMediaExtension || isMediaContent) {
      return { ok: false, code: 'UNSUPPORTED_FORMAT', message: AUDIO_VIDEO_HINT };
    }
    return {
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      message: declaredExtension ? `暂不支持 .${declaredExtension} 格式` : '文件缺少扩展名，无法判断格式',
    };
  }

  const extensionFormat = formatFromExtension(declaredExtension);
  if (!extensionFormat) {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', message: `暂不支持 .${declaredExtension} 格式` };
  }

  const kind = detectContentKind(bytes);

  // ② 内容必须能确定格式
  if (kind === 'UNKNOWN') {
    return {
      ok: false,
      code: 'MAGIC_MISMATCH',
      message: '无法识别文件内容（既不是文本，也不是受支持的文档格式）',
    };
  }
  if (kind === 'ZIP') {
    return {
      ok: false,
      code: 'MAGIC_MISMATCH',
      message: '这是一个普通压缩包，不是 Word 文档；请解压后再导入具体文件',
    };
  }
  if (kind === 'AUDIO' || kind === 'VIDEO') {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', message: AUDIO_VIDEO_HINT };
  }

  // ③ 嗅探结果 vs 扩展名
  if (!EXTENSION_COMPATIBILITY[kind].includes(extensionFormat)) {
    return {
      ok: false,
      code: 'MAGIC_MISMATCH',
      message: `文件内容与扩展名不一致：.${declaredExtension} 里实际是 ${kind} 内容，已拒绝导入`,
    };
  }

  // ④ 嗅探结果 vs 声明的 MIME
  if (!mimeCompatible(kind, declaredMime)) {
    return {
      ok: false,
      code: 'MAGIC_MISMATCH',
      message: `文件内容与声明的类型不一致（声明 ${declaredMime}，实际 ${kind}），已拒绝导入`,
    };
  }

  return { ok: true, format: extensionFormat };
}

/** 材料格式 → 默认落盘扩展名（PASTED_TEXT 用 txt 存正文快照）。 */
export function extensionForFormat(format: string): string {
  switch (format) {
    case 'MARKDOWN':
      return 'md';
    case 'HTML':
      return 'html';
    case 'PDF':
      return 'pdf';
    case 'DOCX':
      return 'docx';
    default:
      return 'txt';
  }
}

export { MIME_ALLOWLIST, DOCX_REQUIRED_ENTRIES };
