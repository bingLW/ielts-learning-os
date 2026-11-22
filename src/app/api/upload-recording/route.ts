/**
 * 录音上传 Route Handler：POST /api/upload-recording
 */

import { NextResponse } from 'next/server';
import { uploadRecordingAction } from '@/lib/actions/listening';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const result = await uploadRecordingAction(formData);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json(result, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, error: '录音上传失败' }, { status: 500 });
  }
}
