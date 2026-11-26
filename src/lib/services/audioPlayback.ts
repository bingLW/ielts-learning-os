/** 已登记音频/录音的安全播放与 Range 流式响应。 */

import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { openRegisteredAudioFile } from '@/lib/services/audioStorage';
import type { RegisteredAudioFile } from '@/lib/services/audioStorage';

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function playRegisteredAudio(
  request: Request,
  kind: 'audio' | 'recording',
  id: string,
): Promise<NextResponse> {
  const asset = kind === 'audio'
    ? await prisma.audioAsset.findFirst({ where: { id, deletedAt: null }, select: { filePath: true, mimeType: true } })
    : await prisma.recordingAsset.findFirst({ where: { id, deletedAt: null }, select: { filePath: true, mimeType: true } });
  if (!asset) return NextResponse.json({ error: '音频不存在或已删除' }, { status: 404 });

  let file: RegisteredAudioFile;
  try {
    file = await openRegisteredAudioFile(asset.filePath);
  } catch {
    return NextResponse.json({ error: '音频文件不可用' }, { status: 404 });
  }
  try {
    const fileSize = file.sizeBytes;
    const range = request.headers.get('range');
    const selection = range ? parseRange(range, fileSize) : { start: 0, end: fileSize - 1 };
    if (!selection) {
      await file.handle.close();
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}`, 'Accept-Ranges': 'bytes' },
      });
    }
    const stream = file.handle.createReadStream({
      autoClose: true,
      start: selection.start,
      end: selection.end,
    });
    stream.on('error', () => { /* 客户端断开时由响应生命周期处理，避免未捕获事件。 */ });
    const headers: Record<string, string> = {
      'Content-Type': asset.mimeType ?? 'audio/mpeg',
      'Content-Length': String(selection.end - selection.start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (range) headers['Content-Range'] = `bytes ${selection.start}-${selection.end}/${fileSize}`;
    const body = Readable.toWeb(stream) as ReadableStream;
    return new NextResponse(body, { status: range ? 206 : 200, headers });
  } catch {
    // stream 已接管 handle 时 autoClose 会关闭；此前失败则显式关闭。
    try { await file.handle.close(); } catch { /* 已关闭 */ }
    return NextResponse.json({ error: '音频文件不可用' }, { status: 404 });
  }
}
