import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findAudio, openedHandles } = vi.hoisted(() => ({
  findAudio: vi.fn(),
  openedHandles: [] as Array<{ fd: number; close: () => Promise<void> }>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      openedHandles.push(handle);
      return handle;
    },
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    audioAsset: { findFirst: findAudio },
    recordingAsset: { findFirst: findAudio },
  },
}));

import { playRegisteredAudio } from '@/lib/services/audioPlayback';
import { writeUploadedFile } from '@/lib/storage';

const storedFiles: string[] = [];

function audioAsset(bytes = Buffer.from('0123456789')) {
  const stored = writeUploadedFile(bytes, 'wav');
  storedFiles.push(stored.absolutePath);
  findAudio.mockResolvedValue({
    filePath: stored.relativePath,
    mimeType: 'audio/wav',
  });
  return bytes;
}

beforeEach(() => {
  findAudio.mockReset();
  openedHandles.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of openedHandles.splice(0)) {
    if (handle.fd >= 0) await handle.close();
  }
  for (const file of storedFiles.splice(0)) rmSync(file, { force: true });
});

describe('已登记音频播放生命周期', () => {
  it('Range 不合法时返回 416 并关闭已打开的文件', async () => {
    audioAsset();

    const response = await playRegisteredAudio(
      new Request('http://local/api/audio/asset', { headers: { range: 'bytes=99-100' } }),
      'audio',
      'asset',
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(openedHandles).toHaveLength(1);
    expect(openedHandles[0].fd).toBe(-1);
  });

  it('完整响应与 Range 响应返回同一文件内容并在读完后关闭', async () => {
    const bytes = audioAsset();

    const full = await playRegisteredAudio(new Request('http://local/api/audio/asset'), 'audio', 'asset');
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);

    const range = await playRegisteredAudio(
      new Request('http://local/api/audio/asset', { headers: { range: 'bytes=2-5' } }),
      'audio',
      'asset',
    );
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(2, 6));
    expect(openedHandles).toHaveLength(2);
    await vi.waitFor(() => expect(openedHandles.every((handle) => handle.fd === -1)).toBe(true));
  });

  it('客户端中断读取时销毁流并关闭文件', async () => {
    audioAsset(Buffer.alloc(64 * 1024, 1));

    const response = await playRegisteredAudio(new Request('http://local/api/audio/asset'), 'audio', 'asset');
    const reader = response.body!.getReader();
    await reader.cancel();

    expect(openedHandles).toHaveLength(1);
    await vi.waitFor(() => expect(openedHandles[0].fd).toBe(-1));
  });

  it('资产不存在时不打开文件', async () => {
    findAudio.mockResolvedValue(null);
    const response = await playRegisteredAudio(new Request('http://local/api/audio/missing'), 'audio', 'missing');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '音频不存在或已删除' });
  });
});
