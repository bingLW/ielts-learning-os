/**
 * 材料上传 Route Handler：POST /api/upload-material（架构 §3.1）。
 *
 * 为什么用 Route Handler 而不是 Server Action：20MB multipart 走 Server Action
 * 会让 Next 把整个 FormData 序列化进 RSC 载荷，内存与延迟都翻倍；这里直接解析
 * 原生 `Request.formData()`，与 `upload-audio` 保持同一范式。
 *
 * 状态码约定：
 * - 200 `{ ok: true, data: { materialId, contentHash, duplicateOf?, limits } }`
 * - 400 校验失败 / 魔数不一致 / 未确认权利
 * - 413 文件超过 20MB（先看 `content-length` 预判，再读 buffer 复核）
 * - 500 落盘或入库异常（已回滚，不含任何路径信息）
 */

import { NextResponse } from 'next/server';
import { MATERIAL_LIMITS } from '@/lib/constants';
import { finalizeMaterialUpload, isOversizeFailure } from '@/lib/materials/upload';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** multipart 边界与字段名的开销，给 content-length 预判留 1MB 余量。 */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MATERIAL_LIMITS.maxFileBytes + MULTIPART_OVERHEAD_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        code: 'VALIDATION',
        error: '文件超过 20MB 上限',
        fieldErrors: { file: '文件超过 20MB 上限' },
      },
      { status: 413 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, code: 'VALIDATION', error: '请求不是合法的表单数据' }, { status: 400 });
  }

  const result = await finalizeMaterialUpload(formData);
  if (!result.ok) {
    const status = result.code === 'VALIDATION' && isOversizeFailure(result.error) ? 413 : 400;
    const httpStatus = result.code === 'INTERNAL' ? 500 : status;
    return NextResponse.json(result, { status: httpStatus });
  }
  return NextResponse.json(result, { status: 200 });
}
