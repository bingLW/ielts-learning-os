/**
 * /library 只读查询。
 *
 * 元数据来自 `ResourceReference`（seed 维护），阅读状态来自 `ResourceReadingLog`
 * （每资源最多一行）。统计由 domain 纯函数计算，页面不重复实现口径。
 */

import { getBusinessTimezone } from '@/lib/businessTime';
import { toBusinessDate } from '@/lib/date';
import { libraryProgress } from '@/lib/domain/library';
import { previewOutput } from '@/lib/domain/evidence';
import { parseStringArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type {
  EvidenceSkill,
  LearningEvidenceType,
  LibraryEvidenceOptionDto,
  MethodologyResourceDto,
  ResourcePriority,
  ResourceReadStatus,
} from '@/lib/types';

const LIBRARY_EVIDENCE_OPTIONS_LIMIT = 30;

export interface LibraryBoard {
  resources: MethodologyResourceDto[];
  stats: ReturnType<typeof libraryProgress>;
  evidenceOptions: LibraryEvidenceOptionDto[];
}

export async function getLibraryBoard(): Promise<LibraryBoard> {
  const timeZone = await getBusinessTimezone();
  const [rows, evidenceRows] = await Promise.all([
    prisma.resourceReference.findMany({
      orderBy: [{ priority: 'asc' }, { sortOrder: 'asc' }],
      include: { readingLogs: { take: 1 } },
    }),
    prisma.evidenceRecord.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: LIBRARY_EVIDENCE_OPTIONS_LIMIT,
      select: {
        id: true,
        skill: true,
        evidenceType: true,
        outputText: true,
        note: true,
        createdAt: true,
      },
    }),
  ]);

  const resources: MethodologyResourceDto[] = rows.map((row) => {
    const log = row.readingLogs[0];
    return {
      id: row.id,
      title: row.title,
      creator: row.creator,
      url: row.url,
      resourceType: row.resourceType,
      priority: row.priority as ResourcePriority,
      sourceUpdated: row.sourceUpdated,
      accessedAt: row.accessedAt,
      licenseNote: row.licenseNote,
      stageFit: parseStringArray(row.stageFit),
      status: row.status,
      category: row.category,
      summary: row.summary,
      reading: log
        ? {
            status: log.status as ResourceReadStatus,
            personalSummary: log.personalSummary,
            plannedAction: log.plannedAction,
            appliedEvidenceId: log.appliedEvidenceId,
            lastReadAt: log.lastReadAt,
          }
        : null,
    };
  });

  const stats = libraryProgress(
    rows.map((row) => ({
      priority: row.priority as ResourcePriority,
      readingStatus: (row.readingLogs[0]?.status as ResourceReadStatus | undefined) ?? null,
    })),
  );

  const evidenceOptions: LibraryEvidenceOptionDto[] = evidenceRows.map((row) => ({
    id: row.id,
    skill: row.skill as EvidenceSkill,
    evidenceType: row.evidenceType as LearningEvidenceType,
    preview: previewOutput(row.outputText ?? row.note, 48) ?? '（无正文）',
    businessDate: toBusinessDate(row.createdAt, timeZone),
  }));

  return { resources, stats, evidenceOptions };
}
