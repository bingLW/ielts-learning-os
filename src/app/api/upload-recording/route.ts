/**
 * 录音上传 Route Handler：POST /api/upload-recording
 */

import { NextResponse } from 'next/server';
import { uploadRecordingAction } from '@/lib/actions/listening';
import { RECORDING_MAX_BYTES } from '@/lib/constants';
import { AUDIO_MULTIPART_OVERHEAD_BYTES, AudioValidationError, readBoundedAudioFormData } from '@/lib/services/audioStorage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await readBoundedAudioFormData(request, RECORDING_MAX_BYTES + AUDIO_MULTIPART_OVERHEAD_BYTES);
    const result = await uploadRecordingAction(formData);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof AudioValidationError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ ok: false, error: '录音上传失败' }, { status: 500 });
  }
}
