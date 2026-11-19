/**
 * 复测队列查询（只读）。
 *
 * 与复习中心（ReviewTask）严格分离：这里只读 RetestSchedule，不合并知识型复习。
 */

import { today } from '@/lib/date';
import { previewOutput } from '@/lib/domain/evidence';
import {
  retestEvidenceLevel,
  retestEvidenceType,
  retestOverdueDays,
  sortRetestQueue,
  summarizeRetests,
  type RetestStats,
} from '@/lib/domain/retest';
import { prisma } from '@/lib/prisma';
import type {
  EvidenceSkill,
  LearningEvidenceType,
  RetestCompletionContextDto,
  RetestQueueItemDto,
  RetestStatus,
  RetestType,
} from '@/lib/types';

export async function listRetestQueue(): Promise<RetestQueueItemDto[]> {
  const rows = await prisma.retestSchedule.findMany({
    include: {
      parent: {
        select: {
          evidenceType: true,
          skill: true,
          outputText: true,
          note: true,
          createdAt: true,
        },
      },
    },
    orderBy: [{ dueDate: 'asc' }],
    take: 500,
  });

  const todayStr = today();
  const mapped: RetestQueueItemDto[] = rows.map((row) => ({
    id: row.id,
    parentEvidenceId: row.parentEvidenceId,
    parentType: row.parent.evidenceType as LearningEvidenceType,
    parentSkill: row.parent.skill as EvidenceSkill,
    parentPreview: previewOutput(row.parent.outputText ?? row.parent.note, 60),
    parentCreatedAt: row.parent.createdAt.toISOString(),
    retestType: row.retestType as RetestType,
    dueDate: row.dueDate,
    estMinutes: row.estMinutes,
    status: row.status as RetestStatus,
    planTaskId: row.planTaskId,
    completedEvidenceId: row.completedEvidenceId,
    overdueDays: retestOverdueDays(row.dueDate, todayStr),
  }));

  return sortRetestQueue(mapped);
}

export function getRetestStats(rows: RetestQueueItemDto[]): RetestStats {
  return summarizeRetests(rows, today());
}

/** 从 /retest 进入证据录入时的上下文；非待完成排期返回 null。 */
export async function getRetestCompletionContext(
  scheduleId: string,
): Promise<RetestCompletionContextDto | null> {
  const schedule = await prisma.retestSchedule.findUnique({
    where: { id: scheduleId },
    include: {
      parent: {
        select: {
          skill: true,
          archivedAt: true,
          outputText: true,
          note: true,
          conditionJson: true,
        },
      },
    },
  });
  if (!schedule) return null;
  if (schedule.status !== 'PENDING') return null;
  if (schedule.parent.archivedAt) return null;

  return {
    scheduleId: schedule.id,
    skill: schedule.parent.skill as EvidenceSkill,
    retestType: schedule.retestType as RetestType,
    evidenceType: retestEvidenceType(schedule.retestType as RetestType),
    level: retestEvidenceLevel(schedule.estMinutes),
    dueDate: schedule.dueDate,
    estMinutes: schedule.estMinutes,
    parentPreview: previewOutput(schedule.parent.outputText ?? schedule.parent.note, 60),
    parentPrompt: parsePrompt(schedule.parent.conditionJson),
    parentMaterialSource: parseMaterial(schedule.parent.conditionJson),
  };
}

function parseField(raw: string | null, key: 'prompt' | 'materialSource'): string | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const text = (value as Record<string, unknown>)[key];
    return typeof text === 'string' && text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

function parsePrompt(raw: string | null): string | null {
  return parseField(raw, 'prompt');
}

function parseMaterial(raw: string | null): string | null {
  return parseField(raw, 'materialSource');
}
