/**
 * `/api/materials/[id]/tick` —— ADR-05 的轮询推进端点。
 *
 * 客户端每 3 秒 POST 一次（`MATERIAL_LIMITS.pollIntervalMs`），服务端只推进
 * **一个阶段的一个工作单元**。终态材料直接返回当前状态，不重复干活。
 *
 * 状态码：200 带 `MaterialStatusDto`；404 材料不存在；400 id 不合法。
 * `maxDuration = 60`（Vercel 上限），内部预算 25s（`tickBudgetMs`）。
 */

import { NextResponse } from 'next/server';
import { runPipelineTick } from '@/lib/materials/pipeline';
import { getMaterialStatus } from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
    return NextResponse.json(
      { ok: false, code: 'VALIDATION', error: '材料 id 不合法' },
      { status: 400 },
    );
  }

  try {
    const result = await runPipelineTick(id);
    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : 400;
      return NextResponse.json(result, { status });
    }

    const dto = await getMaterialStatus(id);
    if (!dto) {
      return NextResponse.json(
        { ok: false, code: 'NOT_FOUND', error: '材料不存在或已被删除' },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, data: dto });
  } catch {
    // 绝不透传原始异常（可能含路径）：只回固定文案，详情由 job.errorMessage 承载
    return NextResponse.json(
      { ok: false, code: 'INTERNAL', error: '处理任务推进失败，请稍后重试' },
      { status: 500 },
    );
  }
}
