/**
 * v2.7.1 音频上传安全边界。
 *
 * 声明 MIME、文件名扩展名、实际容器和容器内时长缺一不可。只接受本地常见容器，
 * 不把任意带音频扩展名的 Buffer 当作音频。解析器不做转码，也不会调用外部程序。
 */

import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  AUDIO_ALLOWED_EXTENSIONS,
  AUDIO_ALLOWED_MIME,
  AUDIO_MAX_SECONDS,
  AUDIO_MAX_UPLOAD_BYTES,
  RECORDING_MAX_BYTES,
  RECORDING_MAX_SECONDS,
} from '@/lib/constants';
import { extensionFromFileName, resolveUploadPath } from '@/lib/storage';

export type AudioContainer = 'mp3' | 'm4a' | 'wav' | 'webm' | 'ogg' | 'aac';

export class AudioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioValidationError';
  }
}

const MIME_BY_CONTAINER: Record<AudioContainer, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
};
const CONTAINER_BY_MIME: Record<string, AudioContainer> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
};

function requireBytes(bytes: Buffer, length: number): void {
  if (bytes.length < length) throw new AudioValidationError('音频容器不完整');
}

function id3Length(bytes: Buffer): number {
  if (bytes.length < 10 || bytes.subarray(0, 3).toString('ascii') !== 'ID3') return 0;
  const size = bytes.readUIntBE(6, 4);
  // 每字节只能是 7 bit；高位是同步安全字节，不能作为长度使用。
  if ((size & 0x80808080) !== 0) throw new AudioValidationError('MP3 ID3 标签损坏');
  return 10 + size + (bytes[5] ?? 0);
}

function mp3Frame(bytes: Buffer, offset: number): { length: number; seconds: number } | null {
  if (offset + 4 > bytes.length) return null;
  const header = bytes.readUInt32BE(offset);
  if (((header & 0xffe00000) >>> 0) !== 0xffe00000) return null;
  const version = (header >>> 19) & 3;
  const layer = (header >>> 17) & 3;
  const bitrateIndex = (header >>> 12) & 15;
  const sampleIndex = (header >>> 10) & 3;
  const padding = (header >>> 9) & 1;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const rates = [44100, 48000, 32000];
  const sampleRate = rates[sampleIndex];
  const mpeg1 = version === 3;
  const layer1 = layer === 3;
  const layer2 = layer === 2;
  const bitrates = mpeg1
    ? (layer1 ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
      : layer2 ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
        : [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320])
    : (layer1 ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
      : layer2 ? [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]);
  const samples = layer1 ? 384 : layer2 ? 1152 : mpeg1 ? 1152 : 576;
  const length = layer1
    ? Math.floor((12 * bitrates[bitrateIndex] * 1000 / sampleRate + padding) * 4)
    : layer2
      ? Math.floor(72 * bitrates[bitrateIndex] * 1000 / sampleRate + padding)
      : Math.floor((mpeg1 ? 144 : 72) * bitrates[bitrateIndex] * 1000 / sampleRate + padding);
  if (length < 4) return null;
  return { length, seconds: samples / sampleRate };
}

function parseMp3(bytes: Buffer): number {
  let offset = id3Length(bytes);
  let duration = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    const frame = mp3Frame(bytes, offset);
    if (!frame) {
      const next = bytes.subarray(offset + 1).findIndex((value, index) => {
        const candidate = offset + 1 + index;
        return bytes[candidate] === 0xff && (bytes[candidate + 1] & 0xe0) === 0xe0;
      });
      if (next < 0) break;
      offset += next + 1;
      continue;
    }
    if (offset + frame.length > bytes.length) throw new AudioValidationError('MP3 帧不完整');
    duration += frame.seconds;
    frames += 1;
    offset += frame.length;
  }
  if (frames === 0) throw new AudioValidationError('无法识别音频容器：MP3 音频帧无效');
  return duration;
}

function parseWav(bytes: Buffer): number {
  requireBytes(bytes, 12);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioValidationError('WAV 容器头不匹配');
  }
  if (bytes.readUInt32LE(4) + 8 > bytes.length) throw new AudioValidationError('WAV 容器不完整');
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) throw new AudioValidationError('WAV 数据块不完整');
    if (kind === 'fmt ' && size >= 16) {
      const format = bytes.readUInt16LE(offset + 8);
      byteRate = bytes.readUInt32LE(offset + 16);
      if (![1, 3, 6, 7].includes(format) || byteRate === 0) throw new AudioValidationError('WAV 音频格式无效');
    }
    if (kind === 'data') dataBytes += size;
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !dataBytes) throw new AudioValidationError('WAV 缺少音频格式或数据');
  return dataBytes / byteRate;
}

function ebmlVint(bytes: Buffer, offset: number, keepMarker: boolean): { value: number; length: number; unknownSize: boolean } {
  requireBytes(bytes, offset + 1);
  const first = bytes[offset];
  if (!keepMarker && first === 0xff) {
    requireBytes(bytes, offset + 8);
    if (!bytes.subarray(offset, offset + 8).every((value) => value === 0xff)) throw new AudioValidationError('EBML 长度字段无效');
    return { value: Number.MAX_SAFE_INTEGER, length: 8, unknownSize: true };
  }
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) throw new AudioValidationError('EBML 长度字段无效');
  requireBytes(bytes, offset + length);
  const unknownSize = false;
  let value = keepMarker ? first : first & (mask - 1);
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index];
  return { value, length, unknownSize };
}

function ebmlChildren(bytes: Buffer, start: number, end: number): Array<{ id: number; data: Buffer }> {
  const children: Array<{ id: number; data: Buffer }> = [];
  let offset = start;
  while (offset < end) {
    const id = ebmlVint(bytes, offset, true);
    const size = ebmlVint(bytes, offset + id.length, false);
    const dataStart = offset + id.length + size.length;
    // MediaRecorder 的流式 WebM 常把 Segment 长度写为未知（8 个 0xff），延伸到文件末尾。
    const dataEnd = size.unknownSize ? end : dataStart + size.value;
    if (dataEnd > end || dataEnd < dataStart) throw new AudioValidationError('WebM 元素越界');
    children.push({ id: id.value, data: bytes.subarray(dataStart, dataEnd) });
    offset = dataEnd;
  }
  return children;
}

function parseWebm(bytes: Buffer): number {
  requireBytes(bytes, 4);
  if (bytes.readUInt32BE(0) !== 0x1a45dfa3) throw new AudioValidationError('WebM EBML 头不匹配');
  const header = ebmlVint(bytes, 0, true);
  const headerSize = ebmlVint(bytes, header.length, false);
  if (headerSize.unknownSize) throw new AudioValidationError('WebM EBML 头长度无效');
  const headerChildren = ebmlChildren(bytes, header.length + headerSize.length, header.length + headerSize.length + headerSize.value);
  if (!headerChildren.some((element) => element.id === 0x4282 && element.data.toString('ascii') === 'webm')) {
    throw new AudioValidationError('EBML 容器不是 WebM');
  }
  const bodyOffset = header.length + headerSize.length + headerSize.value;
  const elements = ebmlChildren(bytes, bodyOffset, bytes.length);
  const segments = elements.filter((element) => element.id === 0x18538067);
  if (segments.length !== 1 || elements.some((element) => element.id !== 0x18538067 && element.id !== 0xec)) {
    throw new AudioValidationError('WebM Segment 结构无效');
  }
  const segment = segments[0];
  const segmentChildren = ebmlChildren(segment.data, 0, segment.data.length);
  const infos = segmentChildren.filter((element) => element.id === 0x1549a966);
  if (infos.length !== 1) throw new AudioValidationError('WebM 缺少唯一 Info');
  const info = infos[0];
  const infoChildren = ebmlChildren(info.data, 0, info.data.length);
  const duration = infoChildren.find((element) => element.id === 0x4489);
  let metadataSeconds: number | null = null;
  if (duration) {
    if (![4, 8].includes(duration.data.length)) throw new AudioValidationError('WebM 时长字段无效');
    metadataSeconds = duration.data.length === 4 ? duration.data.readFloatBE(0) : duration.data.readDoubleBE(0);
    if (!Number.isFinite(metadataSeconds) || metadataSeconds <= 0) throw new AudioValidationError('WebM 时长无效');
  }
  // 流式 WebM 常无 Duration：从最后一个 Cluster/SimpleBlock 时间戳推保守上界；
  // 即使有 Duration 也取两者较大值，避免伪短元数据绕过时长上限。
  const scaleElement = infoChildren.find((element) => element.id === 0x2ad7b1);
  const timecodeScale = scaleElement?.data.length === 4 ? scaleElement.data.readUInt32BE(0) : 1_000_000;
  if (!timecodeScale) throw new AudioValidationError('WebM 时基无效');
  let lastTimecode = -1;
  for (const cluster of segmentChildren.filter((element) => element.id === 0x1f43b675)) {
    const children = ebmlChildren(cluster.data, 0, cluster.data.length);
    const timecode = children.find((element) => element.id === 0xe7);
    if (!timecode || ![0, 4, 8].includes(timecode.data.length)) continue;
    const clusterTime = timecode.data.length === 0 ? 0 : timecode.data.length === 4
      ? timecode.data.readUInt32BE(0) : Number(timecode.data.readBigUInt64BE(0));
    for (const block of children.filter((element) => element.id === 0xa3)) {
      const track = ebmlVint(block.data, 0, false);
      if (block.data.length < track.length + 3) continue;
      lastTimecode = Math.max(lastTimecode, clusterTime + block.data.readInt16BE(track.length));
    }
    for (const group of children.filter((element) => element.id === 0xa0)) {
      for (const block of ebmlChildren(group.data, 0, group.data.length).filter((element) => element.id === 0xa3)) {
        const track = ebmlVint(block.data, 0, false);
        if (block.data.length < track.length + 3) continue;
        lastTimecode = Math.max(lastTimecode, clusterTime + block.data.readInt16BE(track.length));
      }
    }
  }
  if (lastTimecode < 0) {
    if (metadataSeconds !== null) return metadataSeconds;
    throw new AudioValidationError('WebM 缺少可识别时长');
  }
  // SimpleBlock 只给帧起始时间；加 120ms 覆盖常见音频帧，避免在上限边缘少算一帧。
  return Math.max(metadataSeconds ?? 0, (lastTimecode + 120) * timecodeScale / 1_000_000_000);
}

function mp4Atoms(bytes: Buffer, start: number, end: number): Array<{ kind: string; start: number; dataStart: number; end: number }> {
  const atoms: Array<{ kind: string; start: number; dataStart: number; end: number }> = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new AudioValidationError('MP4 元素头不完整');
    let size = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new AudioValidationError('MP4 扩展元素头不完整');
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new AudioValidationError('MP4 元素过大');
      size = Number(extended);
      headerSize = 16;
    }
    if (size !== 0 && size < headerSize) throw new AudioValidationError('MP4 元素长度无效');
    const atomEnd = size === 0 ? end : offset + size;
    if (atomEnd > end || atomEnd <= offset) throw new AudioValidationError('MP4 容器不完整');
    atoms.push({ kind, start: offset, dataStart: offset + headerSize, end: atomEnd });
    offset = atomEnd;
  }
  return atoms;
}

function parseMp4(bytes: Buffer): number {
  requireBytes(bytes, 16);
  const atoms = mp4Atoms(bytes, 0, bytes.length);
  const ftyp = atoms[0];
  const audioBrands = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'isom', 'iso2', 'mp41', 'mp42']);
  if (!ftyp || ftyp.kind !== 'ftyp' || ftyp.end - ftyp.dataStart < 8 || !audioBrands.has(bytes.toString('ascii', ftyp.dataStart, ftyp.dataStart + 4))) {
    throw new AudioValidationError('M4A 容器品牌不匹配');
  }
  const moov = atoms.find((atom) => atom.kind === 'moov');
  const mdat = atoms.find((atom) => atom.kind === 'mdat');
  if (!moov || !mdat || mdat.end <= mdat.dataStart) throw new AudioValidationError('M4A 缺少 moov 或音频数据');
  const moovChildren = mp4Atoms(bytes, moov.dataStart, moov.end);
  const mvhd = moovChildren.find((atom) => atom.kind === 'mvhd');
  if (!mvhd || mvhd.end - mvhd.dataStart < 20) throw new AudioValidationError('M4A 缺少 mvhd');
  const version = bytes[mvhd.dataStart];
  if (![0, 1].includes(version)) throw new AudioValidationError('M4A mvhd 版本无效');
  const timescale = version === 1 ? bytes.readUInt32BE(mvhd.dataStart + 20) : bytes.readUInt32BE(mvhd.dataStart + 12);
  const ticks = version === 1
    ? (mvhd.end - mvhd.dataStart >= 32 ? bytes.readBigUInt64BE(mvhd.dataStart + 24) : 0n)
    : BigInt(bytes.readUInt32BE(mvhd.dataStart + 16));
  if (timescale === 0) throw new AudioValidationError('M4A 时基无效');
  const duration = Number(ticks) / timescale;
  if (!Number.isFinite(duration) || duration <= 0) throw new AudioValidationError('M4A 时长无效');

  let hasAudioTrack = false;
  for (const trak of moovChildren.filter((atom) => atom.kind === 'trak')) {
    const mdia = mp4Atoms(bytes, trak.dataStart, trak.end).find((atom) => atom.kind === 'mdia');
    if (!mdia) continue;
    const hdlr = mp4Atoms(bytes, mdia.dataStart, mdia.end).find((atom) => atom.kind === 'hdlr');
    if (hdlr && hdlr.end - hdlr.dataStart >= 12 && bytes.toString('ascii', hdlr.dataStart + 8, hdlr.dataStart + 12) === 'soun') {
      hasAudioTrack = true;
      break;
    }
  }
  if (!hasAudioTrack) throw new AudioValidationError('M4A 缺少音频轨道');
  return duration;
}

function parseAac(bytes: Buffer): number {
  let offset = 0;
  let frames = 0;
  let seconds = 0;
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  while (offset + 7 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0) throw new AudioValidationError('AAC ADTS 帧头不匹配');
    const rateIndex = (bytes[offset + 2] >>> 2) & 15;
    const length = ((bytes[offset + 3] & 3) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >>> 5);
    if (rateIndex >= rates.length || length < 7 || offset + length > bytes.length) throw new AudioValidationError('AAC ADTS 帧无效');
    seconds += 1024 / rates[rateIndex];
    frames += 1;
    offset += length;
  }
  if (frames === 0 || offset !== bytes.length) throw new AudioValidationError('AAC ADTS 音频不完整');
  return seconds;
}

function parseOgg(bytes: Buffer): number {
  requireBytes(bytes, 27);
  if (bytes.toString('ascii', 0, 4) !== 'OggS' || bytes[4] !== 0) throw new AudioValidationError('Ogg 容器头不匹配');
  let offset = 0;
  let pages = 0;
  let granule = 0n;
  let rate = 0;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'OggS') {
      throw new AudioValidationError('Ogg 页不完整');
    }
    const segments = bytes[offset + 26];
    if (offset + 27 + segments > bytes.length) throw new AudioValidationError('Ogg 段表不完整');
    const table = bytes.subarray(offset + 27, offset + 27 + segments);
    const payload = table.reduce((sum, value) => sum + value, 0);
    const payloadStart = offset + 27 + segments;
    if (payloadStart + payload > bytes.length) throw new AudioValidationError('Ogg 载荷不完整');
    if (bytes[offset + 5] & 4) granule = bytes.readBigUInt64LE(offset + 6);
    if (pages === 0) {
      if (bytes.subarray(payloadStart, payloadStart + 8).toString('ascii') === 'OpusHead') rate = 48000;
      else if (bytes.subarray(payloadStart, payloadStart + 7).toString('ascii') === '\x01vorbis') {
        rate = bytes.readUInt32LE(payloadStart + 12);
      }
    }
    pages += 1;
    offset = payloadStart + payload;
  }
  if (pages < 2 || rate === 0 || granule === 0n) throw new AudioValidationError('Ogg 缺少可识别音频流或时长');
  return Number(granule) / rate;
}

export interface AudioInspection {
  container: AudioContainer;
  mimeType: string;
  durationSec: number;
}

/** 根据魔数识别容器并提取时长；任何一项失败都拒绝落盘。 */
export function inspectAudio(bytes: Buffer): AudioInspection {
  const container: AudioContainer | null = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WAVE' ? 'wav'
    : bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3 ? 'webm'
      : bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS' ? 'ogg'
        : bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp' ? 'm4a'
          : bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0 ? 'aac'
            : 'mp3';
  try {
    const durationSec = container === 'mp3' ? parseMp3(bytes)
      : container === 'm4a' ? parseMp4(bytes)
        : container === 'wav' ? parseWav(bytes)
          : container === 'webm' ? parseWebm(bytes)
            : container === 'ogg' ? parseOgg(bytes)
              : parseAac(bytes);
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new AudioValidationError('音频时长无效');
    return { container, mimeType: MIME_BY_CONTAINER[container], durationSec };
  } catch (error) {
    if (error instanceof AudioValidationError && error.message.includes(container === 'mp3' ? 'MP3' : container === 'm4a' ? 'M4A' : container === 'wav' ? 'WAV' : container === 'webm' ? 'WebM' : container === 'ogg' ? 'Ogg' : 'AAC')) throw error;
    throw new AudioValidationError(`文件内容不是可识别的音频容器：${error instanceof Error ? error.message : '解析失败'}`);
  }
}

export interface ValidatedAudio {
  inspection: AudioInspection;
  extension: AudioContainer;
  durationSec: number;
}

export const AUDIO_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** Route Handler 在解析 multipart 前限制请求体，避免超大或 chunked 上传先被完整缓冲。 */
export async function readBoundedAudioFormData(request: Request, maxBytes: number): Promise<FormData> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AudioValidationError('上传请求超过大小上限');
  }
  if (!request.body) throw new AudioValidationError('上传请求为空');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AudioValidationError('上传请求超过大小上限');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
    throw new AudioValidationError('上传必须使用 multipart/form-data');
  }
  return new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData();
}

/** multipart/Server Action 共用的大小、声明 MIME、双扩展名、魔数和时长校验。 */
export function validateAudioUpload(input: {
  bytes: Buffer;
  fileName: string;
  declaredMimeType?: string | null;
  declaredFileName?: string;
  declaredDurationSec?: number;
  recording?: boolean;
}): ValidatedAudio {
  const maxBytes = input.recording ? RECORDING_MAX_BYTES : AUDIO_MAX_UPLOAD_BYTES;
  const maxSeconds = input.recording ? RECORDING_MAX_SECONDS : AUDIO_MAX_SECONDS;
  if (input.bytes.length === 0) throw new AudioValidationError('文件为空');
  if (input.bytes.length > maxBytes) throw new AudioValidationError(`文件超过 ${Math.round(maxBytes / 1024 / 1024 * 10) / 10}MB 上限`);
  const extension = extensionFromFileName(input.declaredFileName ?? input.fileName);
  if (!AUDIO_ALLOWED_EXTENSIONS.includes(extension as (typeof AUDIO_ALLOWED_EXTENSIONS)[number])) {
    throw new AudioValidationError('不支持的音频扩展名');
  }
  if (input.declaredFileName && extensionFromFileName(input.fileName) !== extension) {
    throw new AudioValidationError('文件名与声明文件名的扩展名不一致');
  }
  if (input.recording && extension !== 'webm') throw new AudioValidationError('录音只支持 WebM');
  const mime = (input.declaredMimeType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!AUDIO_ALLOWED_MIME.includes(mime as (typeof AUDIO_ALLOWED_MIME)[number])) {
    throw new AudioValidationError('必须声明受支持的音频 MIME');
  }
  const expected = CONTAINER_BY_MIME[mime];
  if (!expected || expected !== extension) {
    throw new AudioValidationError('声明 MIME 与扩展名不匹配');
  }
  const inspection = inspectAudio(input.bytes);
  if (inspection.container !== extension || (inspection.mimeType === 'audio/wav' ? mime !== 'audio/wav' && mime !== 'audio/x-wav' : inspection.mimeType !== mime)) {
    throw new AudioValidationError('声明 MIME/扩展名与实际音频容器不匹配');
  }
  if (input.declaredDurationSec !== undefined && (!Number.isInteger(input.declaredDurationSec) || input.declaredDurationSec < 0)) {
    throw new AudioValidationError('声明时长必须是非负整数秒');
  }
  if (inspection.durationSec > maxSeconds || (input.declaredDurationSec !== undefined && input.declaredDurationSec > maxSeconds)) {
    throw new AudioValidationError(`音频时长超过 ${maxSeconds} 秒上限`);
  }
  if (input.declaredDurationSec !== undefined) {
    // 浏览器计时存在取整误差；超出 1 秒或 2% 的声明值不可信，不能用于放大资产时长。
    const toleranceSec = Math.max(1, inspection.durationSec * 0.02);
    if (Math.abs(inspection.durationSec - input.declaredDurationSec) > toleranceSec) {
      throw new AudioValidationError('声明时长与音频容器实际时长不一致');
    }
  }
  return {
    inspection,
    extension,
    durationSec: Math.max(1, Math.round(inspection.durationSec)),
  };
}

export interface RegisteredAudioFile {
  handle: FileHandle;
  absolutePath: string;
  sizeBytes: number;
}

/** 校验后以 O_NOFOLLOW 打开，并核对 fd 与路径仍指向同一普通文件。 */
export async function openRegisteredAudioFile(relativePath: string): Promise<RegisteredAudioFile> {
  let handle: FileHandle | undefined;
  try {
    const absolutePath = resolveUploadPath(relativePath);
    const before = await lstat(absolutePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new AudioValidationError('资产不是普通文件');
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [info, after, canonicalPath] = await Promise.all([handle.stat(), lstat(absolutePath), realpath(absolutePath)]);
    if (!info.isFile() || info.size <= 0 || info.dev !== before.dev || info.ino !== before.ino
      || after.dev !== before.dev || after.ino !== before.ino || canonicalPath !== absolutePath) {
      throw new AudioValidationError('资产在校验后发生变化');
    }
    return { handle, absolutePath, sizeBytes: info.size };
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    throw new AudioValidationError('资产路径不在 storage/uploads 内、包含 symlink 或文件不可用');
  }
}

/** 已登记文件的播放边界：词法路径、realpath、目录范围和普通文件全部校验。 */
export async function resolveRegisteredAudioPath(relativePath: string): Promise<string> {
  const file = await openRegisteredAudioFile(relativePath);
  await file.handle.close();
  return file.absolutePath;
}
