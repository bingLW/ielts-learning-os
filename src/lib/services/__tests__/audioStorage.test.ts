import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIO_MAX_SECONDS, AUDIO_MAX_UPLOAD_BYTES, RECORDING_MAX_SECONDS } from '@/lib/constants';
import { inspectAudio, readBoundedAudioFormData, resolveRegisteredAudioPath, validateAudioUpload } from '@/lib/services/audioStorage';
import { resolveUploadPath, uploadsDir, writeUploadedFile } from '@/lib/storage';

function wav(seconds = 1): Buffer {
  const data = Buffer.alloc(8000 * seconds);
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}

function ebmlId(id: number): Buffer {
  const hex = id.toString(16).padStart(Math.ceil(id.toString(16).length / 2) * 2, '0');
  return Buffer.from(hex, 'hex');
}
function ebmlElement(id: number, data: Buffer): Buffer {
  if (data.length >= 127) throw new Error('fixture too large');
  return Buffer.concat([ebmlId(id), Buffer.from([0x80 | data.length]), data]);
}
function webm(seconds = 1): Buffer {
  const duration = Buffer.alloc(8); duration.writeDoubleBE(seconds);
  const header = ebmlElement(0x1a45dfa3, ebmlElement(0x4282, Buffer.from('webm')));
  const info = ebmlElement(0x1549a966, ebmlElement(0x4489, duration));
  return Buffer.concat([header, ebmlElement(0x18538067, info)]);
}

function mp3(): Buffer {
  const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array<number>(413).fill(0)]);
  return Buffer.concat([frame, frame, frame, frame]);
}
function aac(): Buffer {
  return Buffer.from([0xff, 0xf1, 0x50, 0x00, 0x00, 0xe0, 0xfc]);
}
function mp4Atom(kind: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(8 + data.length);
  bytes.writeUInt32BE(bytes.length, 0); bytes.write(kind, 4); data.copy(bytes, 8);
  return bytes;
}
function m4a(): Buffer {
  const ftyp = mp4Atom('ftyp', Buffer.concat([Buffer.from('M4A '), Buffer.alloc(4), Buffer.from('M4A isom')]));
  const mvhd = Buffer.alloc(24); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(1000, 16);
  const hdlr = Buffer.alloc(12); hdlr.write('soun', 8);
  const trak = mp4Atom('trak', mp4Atom('mdia', mp4Atom('hdlr', hdlr)));
  const moov = mp4Atom('moov', Buffer.concat([mp4Atom('mvhd', mvhd), trak]));
  return Buffer.concat([ftyp, moov, mp4Atom('mdat', Buffer.from([0]))]);
}
function streamingWebm(seconds = 1, blockGroup = false): Buffer {
  const header = ebmlElement(0x1a45dfa3, ebmlElement(0x4282, Buffer.from('webm')));
  const info = ebmlElement(0x1549a966, Buffer.alloc(0));
  const timecode = Buffer.alloc(4); timecode.writeUInt32BE(seconds * 1000);
  const block = ebmlElement(0xa3, Buffer.from([0x81, 0, 0, 0]));
  const payload = blockGroup ? ebmlElement(0xa0, block) : block;
  const cluster = ebmlElement(0x1f43b675, Buffer.concat([ebmlElement(0xe7, timecode), payload]));
  return Buffer.concat([header, ebmlId(0x18538067), Buffer.alloc(8, 0xff), info, cluster]);
}
function aacFrame(rateIndex: number): Buffer {
  const frame = Buffer.from([0xff, 0xf1, 0x50, 0x00, 0x00, 0xe0, 0xfc]);
  frame[2] = (frame[2] & 0x03) | (rateIndex << 2);
  return frame;
}
function ogg(): Buffer {
  const page = (payload: Buffer, granule: bigint, flags: number) => {
    const bytes = Buffer.alloc(28 + payload.length);
    bytes.write('OggS', 0); bytes[4] = 0; bytes[5] = flags; bytes.writeBigUInt64LE(granule, 6); bytes.writeUInt32BE(1, 14); bytes[26] = 1; bytes[27] = payload.length; payload.copy(bytes, 28);
    return bytes;
  };
  return Buffer.concat([
    page(Buffer.from('OpusHead\x01\x02'), 0n, 2),
    page(Buffer.alloc(1), 48000n, 4),
  ]);
}

describe('音频上传容器、声明与时长校验', () => {
  it.each([
    ['mp3', 'audio/mpeg', mp3()],
    ['wav', 'audio/wav', wav()],
    ['webm', 'audio/webm', webm()],
    ['m4a', 'audio/mp4', m4a()],
    ['ogg', 'audio/ogg', ogg()],
    ['aac', 'audio/aac', aac()],
  ] as const)('识别真实 %s 容器和时长', (extension, mime, bytes) => {
    const result = validateAudioUpload({ bytes, fileName: `sample.${extension}`, declaredMimeType: mime });
    expect(result.extension).toBe(extension);
    expect(result.inspection.durationSec).toBeGreaterThan(0);
  });

  it('拒绝伪造扩展名、MIME 与容器', () => {
    expect(() => validateAudioUpload({ bytes: wav(), fileName: 'fake.mp3', declaredMimeType: 'audio/mpeg' })).toThrow(/不匹配/);
    expect(() => validateAudioUpload({ bytes: Buffer.from('not audio'), fileName: 'fake.wav', declaredMimeType: 'audio/wav' })).toThrow(/容器/);
    expect(() => validateAudioUpload({ bytes: wav(), fileName: 'fake.exe', declaredMimeType: 'audio/wav' })).toThrow(/扩展名/);
    expect(() => validateAudioUpload({ bytes: wav(), fileName: 'fake.wav', declaredMimeType: '' })).toThrow(/MIME/);
    expect(() => validateAudioUpload({ bytes: wav(), fileName: 'fake.wav', declaredMimeType: 'audio/wav', declaredFileName: 'other.mp3' })).toThrow(/扩展名/);
  });

  it('拒绝截断容器，而不是只看魔数', () => {
    expect(() => inspectAudio(wav().subarray(0, 40))).toThrow(/WAV/);
    expect(() => inspectAudio(webm().subarray(0, webm().length - 1))).toThrow(/WebM|容器/);
  });

  it('同时检查容器真实时长与声明时长上限', () => {
    expect(() => validateAudioUpload({ bytes: wav(AUDIO_MAX_SECONDS + 1), fileName: 'long.wav', declaredMimeType: 'audio/wav' })).toThrow(/上限/);
    expect(() => validateAudioUpload({ bytes: wav(2), fileName: 'a.wav', declaredMimeType: 'audio/wav', declaredDurationSec: AUDIO_MAX_SECONDS + 1 })).toThrow(/上限/);
    expect(() => validateAudioUpload({ bytes: webm(RECORDING_MAX_SECONDS + 1), fileName: 'a.webm', declaredMimeType: 'audio/webm', recording: true })).toThrow(/上限/);
  });

  it('支持 MediaRecorder 未知 Segment 长度和无 Duration 的流式 WebM', () => {
    const result = validateAudioUpload({ bytes: streamingWebm(), fileName: 'live.webm', declaredMimeType: 'audio/webm', recording: true });
    expect(result.inspection.durationSec).toBeCloseTo(1.12);
    expect(() => validateAudioUpload({ bytes: streamingWebm(91), fileName: 'long.webm', declaredMimeType: 'audio/webm', recording: true })).toThrow(/上限/);
  });

  it('读取 WebM BlockGroup 内 SimpleBlock 的时间戳', () => {
    const result = validateAudioUpload({ bytes: streamingWebm(2, true), fileName: 'block-group.webm', declaredMimeType: 'audio/webm', recording: true });
    expect(result.inspection.durationSec).toBeCloseTo(2.12);
    expect(() => validateAudioUpload({ bytes: streamingWebm(91, true), fileName: 'long.webm', declaredMimeType: 'audio/webm', recording: true })).toThrow(/上限/);
  });

  it('AAC 混合采样率按每帧采样率累计时长', () => {
    const result = inspectAudio(Buffer.concat([aacFrame(4), aacFrame(3)]));
    expect(result.container).toBe('aac');
    expect(result.durationSec).toBeCloseTo(1024 / 44100 + 1024 / 48000, 8);
  });

  it('拒绝与容器实际时长差异超过计时误差的声明值', () => {
    expect(() => validateAudioUpload({ bytes: wav(2), fileName: 'a.wav', declaredMimeType: 'audio/wav', declaredDurationSec: 0 })).toThrow(/不一致/);
    const accepted = validateAudioUpload({ bytes: wav(2), fileName: 'a.wav', declaredMimeType: 'audio/wav', declaredDurationSec: 1 });
    expect(accepted.durationSec).toBe(2);
  });

  it('拒绝伪装成 M4A 的纯元数据容器', () => {
    const withoutAudio = m4a().subarray(0, m4a().length - 9);
    expect(() => inspectAudio(withoutAudio)).toThrow(/M4A/);
  });

  it('拒绝空文件和超大小文件', () => {
    expect(() => validateAudioUpload({ bytes: Buffer.alloc(0), fileName: 'a.wav', declaredMimeType: 'audio/wav' })).toThrow(/为空/);
    expect(() => validateAudioUpload({ bytes: Buffer.alloc(AUDIO_MAX_UPLOAD_BYTES + 1), fileName: 'a.wav', declaredMimeType: 'audio/wav' })).toThrow(/上限/);
  });
});

describe('上传请求体边界', () => {
  it('解析 multipart 前拒绝超限 Content-Length 和 chunked 请求体', async () => {
    const tooLong = new Request('http://local/upload', { method: 'POST', headers: { 'content-length': '9999' } });
    await expect(readBoundedAudioFormData(tooLong, 100)).rejects.toThrow(/上限/);
    const chunked = new Request('http://local/upload', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: Buffer.alloc(101) });
    await expect(readBoundedAudioFormData(chunked, 100)).rejects.toThrow(/上限/);
  });
});

describe('上传目录 realpath 边界', () => {
  it('拒绝目录穿越、绝对路径和符号链接', async () => {
    expect(() => resolveUploadPath('../dev.db')).toThrow();
    expect(() => resolveUploadPath('/etc/passwd')).toThrow();
    const name = `v271-test-${randomBytes(6).toString('hex')}`;
    const target = path.join(tmpdir(), `${name}.wav`);
    const link = path.join(uploadsDir(), `${name}.wav`);
    writeFileSync(target, wav());
    symlinkSync(target, link);
    try {
      expect(() => resolveUploadPath(`${name}.wav`)).toThrow(/符号链接/);
      await expect(resolveRegisteredAudioPath(`${name}.wav`)).rejects.toThrow(/不在|符号链接/);
    } finally {
      rmSync(target, { force: true });
      rmSync(link, { force: true });
    }
  });

  it('正常登记文件以 0600 落盘并可安全解析', async () => {
    const stored = writeUploadedFile(wav(), 'wav');
    try {
      expect(resolveUploadPath(stored.relativePath)).toBe(stored.absolutePath);
      await expect(resolveRegisteredAudioPath(stored.relativePath)).resolves.toBe(stored.absolutePath);
    } finally {
      rmSync(stored.absolutePath, { force: true });
    }
  });
});
