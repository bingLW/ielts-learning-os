/**
 * TypeWords 备份文件读取（v2.3 Phase 2 补充）。
 *
 * TypeWords 设置页的「导出数据」产出 ZIP（内含 data.json + mp3/），
 * 而导入入口另有 .json / .txt 纯文本。这里把两种形态统一成 JSON 文本：
 * - 纯文本：原样返回；
 * - ZIP：按中央目录定位 data.json，支持 store(0) 与 deflate(8)。
 *
 * 纯函数 + 浏览器/Node 共用的 DecompressionStream，不做任何 IO。
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const EOCD_MIN_BYTES = 22;
const EOCD_SEARCH_WINDOW = 65_557; // 22 字节固定区 + 最大 65535 注释

export class BackupArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupArchiveError';
  }
}

export function looksLikeZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const head = new DataView(buffer).getUint32(0, true);
  return head === LOCAL_SIGNATURE || head === EOCD_SIGNATURE;
}

function findEndOfCentralDirectory(view: DataView): number {
  const limit = Math.max(0, view.byteLength - EOCD_SEARCH_WINDOW);
  for (let offset = view.byteLength - EOCD_MIN_BYTES; offset >= limit; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function readCentralDirectory(view: DataView): CentralEntry[] {
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new BackupArchiveError('ZIP 缺少中央目录结尾标记，文件可能被截断');

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount > MAX_ENTRIES) throw new BackupArchiveError(`ZIP 条目过多（${entryCount}），已拒绝解析`);
  if (cdOffset >= view.byteLength) throw new BackupArchiveError('ZIP 中央目录偏移越界');

  const entries: CentralEntry[] = [];
  let offset = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength) throw new BackupArchiveError('ZIP 中央目录被截断');
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new BackupArchiveError('ZIP 中央目录签名错误');
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + nameStart, nameLength);

    entries.push({
      name: new TextDecoder().decode(nameBytes),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function pickDataEntry(entries: CentralEntry[]): CentralEntry {
  const exact = entries.find((entry) => entry.name === 'data.json');
  if (exact) return exact;
  const nested = entries
    .filter((entry) => entry.name.endsWith('/data.json'))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (nested) return nested;

  const jsonEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith('.json'));
  if (jsonEntries.length === 1) return jsonEntries[0]!;

  throw new BackupArchiveError('ZIP 里没有 data.json：请选择 TypeWords「导出数据」得到的压缩包');
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new BackupArchiveError('当前环境不支持 zip 解压，请解压后选择 data.json');
  }
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractEntry(view: DataView, entry: CentralEntry): Promise<Uint8Array> {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new BackupArchiveError(`ZIP 条目过大（${entry.uncompressedSize} 字节），已拒绝解析`);
  }
  const offset = entry.localOffset;
  if (offset + 30 > view.byteLength) throw new BackupArchiveError('ZIP 本地文件头越界');
  if (view.getUint32(offset, true) !== LOCAL_SIGNATURE) throw new BackupArchiveError('ZIP 本地文件头签名错误');

  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > view.byteLength) throw new BackupArchiveError('ZIP 条目数据越界');

  const compressed = new Uint8Array(view.buffer, view.byteOffset + dataStart, entry.compressedSize);
  if (entry.method === ZIP_METHOD_STORE) return compressed;
  if (entry.method === ZIP_METHOD_DEFLATE) return inflateRaw(compressed);
  throw new BackupArchiveError(`ZIP 压缩方式 ${entry.method} 不受支持，请解压后选择 data.json`);
}

/** 把用户选择的备份文件内容读成 JSON 文本；ZIP 与纯文本都可。 */
export async function readBackupArchiveText(buffer: ArrayBuffer): Promise<string> {
  if (!looksLikeZip(buffer)) return new TextDecoder('utf-8').decode(new Uint8Array(buffer));

  const view = new DataView(buffer);
  const entries = readCentralDirectory(view);
  const dataEntry = pickDataEntry(entries);
  const bytes = await extractEntry(view, dataEntry);
  return new TextDecoder('utf-8').decode(bytes);
}
