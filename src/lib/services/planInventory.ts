import { createHash } from 'node:crypto';
import type { PlanTask, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { effectiveActualMinutesByTask } from '@/lib/services/carryoverApply';

export interface PlanInventory {
  fingerprint: string;
  reservedMinutesByDate: Map<string, number>;
}

export function reservedMinutesForTask(
  task: Pick<PlanTask, 'status' | 'plannedMinutes' | 'actualMinutes'>,
  actualMinutes = task.actualMinutes,
): number {
  return task.status === 'DONE' || task.status === 'PARTIAL'
    ? Math.max(0, actualMinutes)
    : Math.max(Math.max(0, actualMinutes), Math.max(0, task.plannedMinutes));
}

export async function loadPlanInventory(
  startDate: string,
  endDate: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<PlanInventory> {
  const rows = await db.planTask.findMany({
    where: {
      planDate: { gte: startDate, lte: endDate },
      status: { notIn: ['CANCELLED', 'DEFERRED'] },
    },
    orderBy: [{ planDate: 'asc' }, { id: 'asc' }],
  });
  const actualByTask = await effectiveActualMinutesByTask(rows, db);
  const reservedMinutesByDate = new Map<string, number>();
  const canonical = rows.map((row) => {
    const actualMinutes = actualByTask.get(row.id) ?? 0;
    const reservedMinutes = reservedMinutesForTask(row, actualMinutes);
    reservedMinutesByDate.set(row.planDate, (reservedMinutesByDate.get(row.planDate) ?? 0) + reservedMinutes);
    return {
      id: row.id,
      planDate: row.planDate,
      status: row.status,
      timerStatus: row.timerStatus,
      timerVersion: row.timerVersion,
      plannedMinutes: row.plannedMinutes,
      actualMinutes,
      planVersion: row.planVersion,
      priority: row.priority,
      movedToDate: row.movedToDate,
      movedCount: row.movedCount,
    };
  });
  return {
    fingerprint: createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex'),
    reservedMinutesByDate,
  };
}
