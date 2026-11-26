/**
 * 领域报表下载（T33）。
 *
 * - `GET /api/export/domain/grammar` → 语法诊断 CSV
 * - `GET /api/export/domain/reviews?format=json` → 复习队列 JSON
 */

import { NextResponse } from 'next/server';
import { getBusinessTimezone } from '@/lib/businessTime';
import { buildDomainExport, isDomainExportKind, toDomainCsv } from '@/lib/export/domain';
import { DOMAIN_EXPORT_KINDS } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<NextResponse> {
  const { kind } = await context.params;

  if (!isDomainExportKind(kind)) {
    return NextResponse.json(
      {
        ok: false,
        error: `不支持的报表类别：${kind}`,
        available: DOMAIN_EXPORT_KINDS,
      },
      { status: 400 },
    );
  }

  const report = await buildDomainExport(kind, await getBusinessTimezone());
  const url = new URL(request.url);
  const format = url.searchParams.get('format') ?? 'csv';

  if (format === 'json') {
    return new NextResponse(
      JSON.stringify(
        {
          ok: true,
          kind: report.kind,
          title: report.title,
          headers: report.headers,
          rows: report.rows.map((row) =>
            Object.fromEntries(report.headers.map((header, index) => [header, row[index] ?? null])),
          ),
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${report.fileName}.json"`,
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  return new NextResponse(toDomainCsv(report), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${report.fileName}.csv"`,
      'X-Row-Count': String(report.rows.length),
      'Cache-Control': 'no-store',
    },
  });
}
