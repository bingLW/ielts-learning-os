/**
 * 零依赖 ZIP 读取器（只读、只解内存，绝不落盘）。
 *
 * 为什么自研：`.docx` 就是 ZIP + OOXML，而我们只需要 `word/document.xml`
 * 一个条目；为它引入 `jszip`/`adm-zip` 会多一个 100KB+ 依赖且默认允许解压到磁盘。
 * 这里只实现「读 EOCD → 扫中央目录 → 取单条目的本地头 → `zlib.inflateRawSync`」，
 * 约 150 行，行为完全可控、可单测。
 *
 * 防护（架构 §5 / T05 验收）：
 * 1. 条目数 ≤ 512（`MATERIAL_LIMITS.maxZipEntries`）；
 * 2. 解压后总量 ≤ 40 MB，且单条目 ≤ 40 MB；
 * 3. 压缩比 ≤ 120（zip bomb）；
 * 4. 条目名含 `..` 或绝对路径 → 直接拒绝（虽然我们永不落盘）；
 * 5. **不支持** 加密条目与未知压缩方法 → 拒绝，不猜。
 */

import { inflateRawSync } from 'node:zlib';
import { MATERIAL_LIMITS } from '@/lib/constants';
import { checkZipBytes, checkZipEntries, checkZipRatio, type LimitCheck } from './limits';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
/** EOCD 最小 22 字节 + 最多 64KB 注释，再留一点余量。 */
const EOCD_SEARCH_WINDOW = 66_000;

export type ZipErrorCode = 'INVALID_ARCHIVE' | 'ARCHIVE_LIMIT' | 'ENTRY_NOT_FOUND';

export class ZipError extends Error {
  readonly code: ZipErrorCode;

  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

export interface ZipEntry {
  name: string;
  /** 0 = stored，8 = deflate。 */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
}

export interface ZipIndex {
  entries: ZipEntry[];
  compressedTotal: number;
  uncompressedTotal: number;
}

/** 是否看起来像 ZIP（只看魔数；是否 DOCX 由 magicNumber 的中央目录检查决定）。 */
export function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_HEADER_SIGNATURE;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const start = Math.max(0, bytes.length - EOCD_SEARCH_WINDOW);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/** 条目名安全：拒绝绝对路径、`..` 段、NUL。我们不落盘，但脏名字仍视为非法归档。 */
function assertSafeEntryName(name: string): void {
  if (!name || name.includes('\0')) throw new ZipError('INVALID_ARCHIVE', '压缩包条目名非法');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ZipError('INVALID_ARCHIVE', '压缩包含绝对路径条目');
  }
  if (name.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new ZipError('INVALID_ARCHIVE', '压缩包含目录穿越条目');
  }
}

function throwIfLimitFailed(check: LimitCheck): void {
  if (!check.ok) throw new ZipError('ARCHIVE_LIMIT', check.message);
}

/**
 * 读中央目录并做全部体积防护。失败抛 `ZipError`。
 *
 * 注意：中央目录里的压缩大小是权威值（本地头可能因为 data descriptor 而为 0），
 * 因此体积判断全部基于中央目录。
 */
export function readZipIndex(bytes: Buffer): ZipIndex {
  if (!isZip(bytes)) throw new ZipError('INVALID_ARCHIVE', '不是有效的 ZIP 文件');
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new ZipError('INVALID_ARCHIVE', '找不到 ZIP 中央目录（可能已损坏）');

  const entryCount = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new ZipError('INVALID_ARCHIVE', '不支持 ZIP64 归档');
  }
  if (directoryOffset + directorySize > bytes.length) {
    throw new ZipError('INVALID_ARCHIVE', 'ZIP 中央目录越界');
  }
  throwIfLimitFailed(checkZipEntries(entryCount));

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  let compressedTotal = 0;
  let uncompressedTotal = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipError('INVALID_ARCHIVE', 'ZIP 中央目录条目损坏');
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = rawName.toString('utf8');
    assertSafeEntryName(name);

    if (bytes.readUInt16LE(cursor + 8) & 0x0001) {
      throw new ZipError('INVALID_ARCHIVE', '不支持加密的压缩包');
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError('INVALID_ARCHIVE', `不支持的压缩方法：${method}`);
    }
    if (uncompressedSize > MATERIAL_LIMITS.maxZipBytes) {
      throw new ZipError('ARCHIVE_LIMIT', `条目 ${name} 解压后超过上限`);
    }

    entries.push({ name, method, compressedSize, uncompressedSize, crc32, localHeaderOffset });
    compressedTotal += compressedSize;
    uncompressedTotal += uncompressedSize;
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  throwIfLimitFailed(checkZipBytes(uncompressedTotal));
  throwIfLimitFailed(checkZipRatio(compressedTotal, uncompressedTotal));

  return { entries, compressedTotal, uncompressedTotal };
}

/** 列出条目名；任何异常都返回 `null`（供 MIME 嗅探安全调用）。 */
export function listZipEntryNames(bytes: Buffer): string[] | null {
  try {
    return readZipIndex(bytes).entries.map((entry) => entry.name);
  } catch {
    return null;
  }
}

/** 读取单个条目内容（内存内解压，绝不写磁盘）。 */
export function readZipEntry(bytes: Buffer, index: ZipIndex, name: string): Buffer {
  const entry = index.entries.find((item) => item.name === name);
  if (!entry) throw new ZipError('ENTRY_NOT_FOUND', `压缩包内缺少 ${name}`);

  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipError('INVALID_ARCHIVE', `条目 ${name} 的本地文件头损坏`);
  }
  const nameLength = bytes.readUInt16LE(header + 26);
  const extraLength = bytes.readUInt16LE(header + 28);
  const dataStart = header + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) throw new ZipError('INVALID_ARCHIVE', `条目 ${name} 数据越界`);

  const raw = bytes.subarray(dataStart, dataEnd);
  let output: Buffer;
  if (entry.method === 0) {
    output = Buffer.from(raw);
  } else {
    try {
      output = inflateRawSync(raw, { maxOutputLength: MATERIAL_LIMITS.maxZipBytes });
    } catch {
      throw new ZipError('INVALID_ARCHIVE', `条目 ${name} 解压失败`);
    }
  }
  if (entry.uncompressedSize > 0 && output.length !== entry.uncompressedSize) {
    throw new ZipError('INVALID_ARCHIVE', `条目 ${name} 解压长度与声明不一致`);
  }
  return output;
}

/** 便捷入口：按名字直接取内容。 */
export function readZipEntryByName(bytes: Buffer, name: string): Buffer {
  return readZipEntry(bytes, readZipIndex(bytes), name);
}

export { EOCD_SIGNATURE, CENTRAL_DIRECTORY_SIGNATURE, LOCAL_HEADER_SIGNATURE };
