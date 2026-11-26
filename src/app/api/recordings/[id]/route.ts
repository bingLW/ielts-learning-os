/** 录音回放：GET /api/recordings/[id]（已删资产返回 404）。 */

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
    return await playRegisteredAudio(request, 'recording', id);
  } catch {
    return NextResponse.json({ error: '录音读取失败' }, { status: 500 });
  }
}
