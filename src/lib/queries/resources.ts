/**
 * 资源库只读查询。8 类初始资源是数据库里的数据行，代码里不存在资源名枚举。
 */

import {
  RESOURCE_SUBJECT_LABEL_ZH,
  RESOURCE_TYPE_LABEL_ZH,
  type ResourceSubject,
  type ResourceType,
} from '@/lib/constants';
import { parseStringArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type { ResourceRowDto } from '@/lib/types';

/** 资源表格（未归档，主材料优先）。 */
export async function listResources(includeArchived = false): Promise<ResourceRowDto[]> {
  const rows = await prisma.resource.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: [{ subject: 'asc' }, { isPrimary: 'desc' }, { name: 'asc' }],
  });

  return rows.map((row) => {
    const progressPercent =
      row.totalUnits && row.totalUnits > 0
        ? Math.min(100, Math.round(((row.currentUnit ?? 0) / row.totalUnits) * 100))
        : null;
    return {
      id: row.id,
      name: row.name,
      subject: row.subject,
      subjectLabel: RESOURCE_SUBJECT_LABEL_ZH[row.subject as ResourceSubject] ?? row.subject,
      type: row.type,
      typeLabel: RESOURCE_TYPE_LABEL_ZH[row.type as ResourceType] ?? row.type,
      applicableStages: parseStringArray(row.applicableStages),
      version: row.version,
      totalUnits: row.totalUnits,
      currentUnit: row.currentUnit,
      progressPercent,
      startDate: row.startDate,
      finishDate: row.finishDate,
      url: row.url,
      note: row.note,
      isPrimary: row.isPrimary,
    };
  });
}

/** 单个资源（编辑表单回填）。 */
export async function getResource(id: string): Promise<ResourceRowDto | null> {
  const row = await prisma.resource.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    subjectLabel: RESOURCE_SUBJECT_LABEL_ZH[row.subject as ResourceSubject] ?? row.subject,
    type: row.type,
    typeLabel: RESOURCE_TYPE_LABEL_ZH[row.type as ResourceType] ?? row.type,
    applicableStages: parseStringArray(row.applicableStages),
    version: row.version,
    totalUnits: row.totalUnits,
    currentUnit: row.currentUnit,
    progressPercent:
      row.totalUnits && row.totalUnits > 0
        ? Math.min(100, Math.round(((row.currentUnit ?? 0) / row.totalUnits) * 100))
        : null,
    startDate: row.startDate,
    finishDate: row.finishDate,
    url: row.url,
    note: row.note,
    isPrimary: row.isPrimary,
  };
}
