/**
 * 周期窗口内的证据计数（唯一口径）。
 *
 * 页面与 Server Action 共用同一份统计，避免「界面显示够 4 次、按钮却拒绝」的漂移。
 */

import { endOfBusinessDay, toUtcInstant } from './date';
import { isComparableEvidence, isDeliveryEvidence } from './domain/cycle';
import { prisma } from './prisma';
import type { EvidenceLevel, LearningEvidenceType } from './types';

export interface CycleEvidenceCounts {
  comparableOutputs: number;
  deliveryEvidence: number;
}

/** 统计 [startDate, endDate] 内未归档证据的可比较输出与交付证据数量。 */
export async function countCycleEvidence(
  startDate: string,
  endDate: string,
): Promise<CycleEvidenceCounts> {
  const rows = await prisma.evidenceRecord.findMany({
    where: {
      archivedAt: null,
      createdAt: { gte: toUtcInstant(startDate), lt: endOfBusinessDay(endDate) },
    },
    select: { evidenceType: true, level: true, outputText: true },
  });

  let comparableOutputs = 0;
  let deliveryEvidence = 0;
  for (const row of rows) {
    if (
      isComparableEvidence({
        level: row.level as EvidenceLevel,
        outputText: row.outputText,
      })
    ) {
      comparableOutputs += 1;
    }
    if (isDeliveryEvidence({ evidenceType: row.evidenceType as LearningEvidenceType })) {
      deliveryEvidence += 1;
    }
  }
  return { comparableOutputs, deliveryEvidence };
}
