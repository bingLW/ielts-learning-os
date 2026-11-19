/**
 * 全量 JSON 导出。含 `schema_version` / `exported_at` / 各表条数。
 */

import { SCHEMA_VERSION, TZ_NAME } from '@/lib/constants';
import { prisma } from '@/lib/prisma';
import type { ExportPayload } from '@/lib/types';
import { EXPORT_TABLES, mapRows, type ExportTable } from './mapping';

/** Prisma delegate 的最小形状（动态取表只为了导出，不做类型体操）。 */
type FindManyCapable = { findMany: (args?: unknown) => Promise<unknown[]> };

async function readTable(table: ExportTable): Promise<Record<string, unknown>[]> {
  const delegate = (prisma as unknown as Record<string, FindManyCapable | undefined>)[table];
  if (!delegate || typeof delegate.findMany !== 'function') return [];
  const rows = await delegate.findMany();
  return mapRows(rows as Record<string, unknown>[]);
}

/** 装配导出载荷。 */
export async function buildExportPayload(): Promise<ExportPayload> {
  const entries = await Promise.all(
    EXPORT_TABLES.map(async (table) => {
      const rows = await readTable(table);
      return [table, rows] as const;
    }),
  );

  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const [table, rows] of entries) {
    data[table] = rows;
    counts[table] = rows.length;
  }

  return {
    schema_version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    timezone: TZ_NAME,
    counts,
    data,
  };
}
