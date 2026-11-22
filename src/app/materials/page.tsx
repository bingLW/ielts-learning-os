/**
 * `/materials` 材料库。
 *
 * 范式对齐 `/resources`：`force-dynamic` + 异步 Server Component 取数 →
 * 把可序列化 DTO 交给 `*Body` 客户端组件。
 */

import { MaterialLibraryBody } from '@/components/materials/MaterialLibraryBody';
import {
  MATERIAL_FORMATS,
  MATERIAL_SOURCE_TYPES,
  MATERIAL_STATUSES,
  type MaterialFormat,
  type MaterialSourceType,
  type MaterialStatus,
} from '@/lib/constants';
import { listMaterials, type MaterialListFilter } from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ status?: string; format?: string; sourceType?: string; q?: string }>;
}

/** 只接受白名单取值，非法查询参数一律忽略（不抛错、不回显）。 */
function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (!value) return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export default async function MaterialsPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const filter: MaterialListFilter = {};
  const status = pick<MaterialStatus>(sp.status, MATERIAL_STATUSES);
  const format = pick<MaterialFormat>(sp.format, MATERIAL_FORMATS);
  const sourceType = pick<MaterialSourceType>(sp.sourceType, MATERIAL_SOURCE_TYPES);
  if (status) filter.status = status;
  if (format) filter.format = format;
  if (sourceType) filter.sourceType = sourceType;
  if (sp.q && sp.q.trim()) filter.q = sp.q.trim().slice(0, 100);

  const [rows, all] = await Promise.all([listMaterials(filter), listMaterials({})]);
  const failedCount = all.filter((item) => item.status === 'failed').length;

  return <MaterialLibraryBody rows={rows} totalCount={all.length} failedCount={failedCount} />;
}
