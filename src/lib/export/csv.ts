/**
 * 按表 CSV 导出。
 *
 * 转义规则遵循 RFC 4180：字段内含逗号 / 双引号 / 换行时整体用双引号包裹，
 * 内部双引号加倍。加 BOM 以便 Excel 正确识别 UTF-8 中文。
 */

import { prisma } from '@/lib/prisma';
import { mapRow, TABLE_FILE_NAME, type ExportTable } from './mapping';

const BOM = '\uFEFF';

type FindManyCapable = { findMany: (args?: unknown) => Promise<unknown[]> };

/** 单元格转义。 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 行数组 → CSV 文本。 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return BOM;
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCell(row[header])).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** 读取单表并转 CSV。 */
export async function buildTableCsv(
  table: ExportTable,
): Promise<{ fileName: string; content: string; rowCount: number }> {
  const delegate = (prisma as unknown as Record<string, FindManyCapable | undefined>)[table];
  const rows =
    delegate && typeof delegate.findMany === 'function'
      ? ((await delegate.findMany()) as Record<string, unknown>[])
      : [];
  const mapped = rows.map((row) => mapRow(row));
  return {
    fileName: `${TABLE_FILE_NAME[table]}.csv`,
    content: toCsv(mapped),
    rowCount: mapped.length,
  };
}

/** 所有表的 CSV 列表（当前 UI 逐表下载，这里留作批量导出扩展点）。 */
export async function buildAllTableCsvs(): Promise<
  { table: ExportTable; fileName: string; content: string; rowCount: number }[]
> {
  const tables = Object.keys(TABLE_FILE_NAME) as ExportTable[];
  const results = [];
  for (const table of tables) {
    const csv = await buildTableCsv(table);
    results.push({ table, ...csv });
  }
  return results;
}
