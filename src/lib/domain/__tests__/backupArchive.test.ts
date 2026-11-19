import { describe, expect, it } from 'vitest';
import {
  BackupArchiveError,
  looksLikeZip,
  readBackupArchiveText,
} from '../backupArchive';

interface TestEntry {
  name: string;
  content: string;
  deflate?: boolean;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function buildZip(entries: TestEntry[]): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = encoder.encode(entry.content);
    const data = entry.deflate ? await deflateRaw(raw) : raw;
    const method = entry.deflate ? 8 : 0;

    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdOffset = offset;
  const cdSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);

  const total = offset + cdSize + eocd.length;
  const zip = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    zip.set(part, cursor);
    cursor += part.length;
  }
  return zip.buffer;
}

describe('readBackupArchiveText', () => {
  const json = '{"version":5,"val":{"dict":{}}}';

  it('识别 ZIP 魔数', async () => {
    const zip = await buildZip([{ name: 'data.json', content: json }]);
    expect(looksLikeZip(zip)).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode('{"a":1}').buffer)).toBe(false);
  });

  it('读取 store 方式压缩包里的 data.json', async () => {
    const zip = await buildZip([
      { name: 'mp3/1.mp3', content: 'binary' },
      { name: 'data.json', content: json },
    ]);
    await expect(readBackupArchiveText(zip)).resolves.toBe(json);
  });

  it('读取 deflate 方式压缩包里的 data.json', async () => {
    const zip = await buildZip([{ name: 'data.json', content: json, deflate: true }]);
    await expect(readBackupArchiveText(zip)).resolves.toBe(json);
  });

  it('支持带一层目录的 data.json', async () => {
    const zip = await buildZip([{ name: 'typewords/data.json', content: json, deflate: true }]);
    await expect(readBackupArchiveText(zip)).resolves.toBe(json);
  });

  it('纯 JSON 文本原样返回', async () => {
    const buffer = new TextEncoder().encode(json).buffer;
    await expect(readBackupArchiveText(buffer)).resolves.toBe(json);
  });

  it('缺少 data.json 时给出可读错误', async () => {
    const zip = await buildZip([{ name: 'readme.txt', content: 'hello' }]);
    await expect(readBackupArchiveText(zip)).rejects.toBeInstanceOf(BackupArchiveError);
  });

  it('截断的压缩包报错而不是静默返回空串', async () => {
    const zip = await buildZip([{ name: 'data.json', content: json }]);
    const truncated = zip.slice(0, zip.byteLength - 10);
    await expect(readBackupArchiveText(truncated)).rejects.toBeInstanceOf(BackupArchiveError);
  });
});
