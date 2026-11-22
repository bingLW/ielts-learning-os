/**
 * 音频文件流式读取：GET /api/audio/[id]
 *
 * 只允许读取 storage/uploads 下的已登记音频（AudioAsset），
 * 经 resolveUploadPath 防目录穿越；返回带 Range 的流，支持播放器拖动。
 */

import { NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { prisma } from '@/lib/prisma';
import { resolveUploadPath } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  const asset = await prisma.audioAsset.findUnique({ where: { id } });
  if (!asset) return NextResponse.json({ error: '音频不存在' }, { status: 404 });

  let absolutePath: string;
  try {
    absolutePath = resolveUploadPath(asset.filePath);
  } catch {
    return NextResponse.json({ error: '非法路径' }, { status: 400 });
  }

  try {
    const info = await stat(absolutePath);
    const mimeType = asset.mimeType ?? 'audio/mpeg';

    // 支持 Range 请求（播放器拖动/分段）。
    const rangeHeader = _request.headers.get('range');
    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : info.size - 1;
      const chunkSize = end - start + 1;
      const stream = createReadStream(absolutePath, { start, end });
      const readable = stream as unknown as ReadableStream;
      return new NextResponse(readable, {
        status: 206,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes ${start}-${end}/${info.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
        },
      });
    }

    const stream = createReadStream(absolutePath) as unknown as ReadableStream;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(info.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return NextResponse.json({ error: '音频文件不可用' }, { status: 404 });
  }
}
