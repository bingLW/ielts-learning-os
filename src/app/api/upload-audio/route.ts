/**
 * 音频上传 Route Handler：POST /api/upload-audio
 *
 * 复用 uploadAudioAction 的校验与落盘逻辑。之所以用 Route Handler 而非 Server Action，
 * 是因为浏览器上传大文件走 multipart，Server Action 对 File 的序列化开销更大，
 * 这里直接用 FormData 解析（两者共享同一 schema 契约）。
 */

import { NextResponse } from 'next/server';
import { uploadAudioAction } from '@/lib/actions/listening';
import { AUDIO_MAX_UPLOAD_BYTES } from '@/lib/constants';
import { AUDIO_MULTIPART_OVERHEAD_BYTES, AudioValidationError, readBoundedAudioFormData } from '@/lib/services/audioStorage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await readBoundedAudioFormData(request, AUDIO_MAX_UPLOAD_BYTES + AUDIO_MULTIPART_OVERHEAD_BYTES);
    const result = await uploadAudioAction(formData);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof AudioValidationError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ ok: false, error: '上传处理失败' }, { status: 500 });
  }
}
