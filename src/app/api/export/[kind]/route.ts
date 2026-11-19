/**
 * 唯一的 Route Handler：文件下载。
 *
 * - `GET /api/export/json` → 全量 JSON
 * - `GET /api/export/csv?table=study_record` → 单表 CSV
 * - `GET /api/export/csv` → 全表 CSV 列表（JSON 形式，说明该用哪个 table 参数）
 */

import { NextResponse } from 'next/server';
import { buildTableCsv } from '@/lib/export/csv';
import { buildExportPayload } from '@/lib/export/json';
import { EXPORT_TABLES, isExportTable } from '@/lib/export/mapping';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<NextResponse> {
  const { kind } = await context.params;

  if (kind === 'json') {
    const payload = await buildExportPayload();
    const fileName = `ielts-learning-os-${payload.exported_at.slice(0, 10)}.json`;
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (kind === 'csv') {
    const url = new URL(request.url);
    const table = url.searchParams.get('table');
    if (!table) {
      return NextResponse.json(
        {
          ok: false,
          error: '请通过 ?table= 指定要导出的表',
          availableTables: EXPORT_TABLES,
        },
        { status: 400 },
      );
    }
    if (!isExportTable(table)) {
      return NextResponse.json(
        { ok: false, error: `未知的表名：${table}`, availableTables: EXPORT_TABLES },
        { status: 400 },
      );
    }
    const csv = await buildTableCsv(table);
    return new NextResponse(csv.content, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csv.fileName}"`,
        'X-Row-Count': String(csv.rowCount),
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json(
    { ok: false, error: `不支持的导出类型：${kind}（可用：json、csv）` },
    { status: 404 },
  );
}
