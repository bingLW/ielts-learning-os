/** 音频播放：GET /api/audio/[id]（已删资产返回 404）。 */

import { NextResponse } from 'next/server';
import { playRegisteredAudio } from '@/lib/services/audioPlayback';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    return await playRegisteredAudio(request, 'audio', id);
  } catch {
    return NextResponse.json({ error: '音频读取失败' }, { status: 500 });
  }
}
