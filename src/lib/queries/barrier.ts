/**
 * 障碍诊断只读查询。
 *
 * 只做读取与 DTO 映射；诊断是记录，不是自动给分。
 */

import { BARRIER_TYPE_LABEL_ZH } from '@/lib/constants';
import { previewOutput } from '@/lib/domain/evidence';
import type { BarrierStats } from '@/lib/domain/barrier';
import { summarizeBarriers } from '@/lib/domain/barrier';
import { prisma } from '@/lib/prisma';
import type {
  AssistanceLevel,
  BarrierDiagnosisDto,
  BarrierEvidenceOptionsBySkill,
  BarrierStatus,
  EvidenceConfidence,
  EvidenceSkill,
  InterventionStatus,
  LearningEvidenceType,
} from '@/lib/types';

/** 障碍列表（聚焦在前；归档默认不显示）。 */
export async function listDiagnosisBarriers(
  includeArchived = false,
): Promise<BarrierDiagnosisDto[]> {
  const rows = await prisma.barrierDiagnosis.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: [{ selectedFocus: 'desc' }, { createdAt: 'desc' }],
    include: {
      interventions: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          barrierId: true,
          action: true,
          successCriteria: true,
          scaffoldLevel: true,
          estimatedMinutes: true,
          status: true,
          preEvidenceId: true,
          postEvidenceId: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    skill: row.skill as EvidenceSkill,
    barrierType: row.barrierType,
    barrierLabel: BARRIER_TYPE_LABEL_ZH[row.barrierType] ?? row.barrierType,
    evidenceId: row.evidenceId,
    evidenceAnchor: row.evidenceAnchor,
    impact: row.impact,
    confidence: row.confidence as EvidenceConfidence,
    selectedFocus: row.selectedFocus,
    status: row.status as BarrierStatus,
    note: row.note,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    interventions: row.interventions.map((item) => ({
      id: item.id,
      barrierId: item.barrierId,
      action: item.action,
      successCriteria: item.successCriteria,
      scaffoldLevel: item.scaffoldLevel as AssistanceLevel,
      estimatedMinutes: item.estimatedMinutes,
      status: item.status as InterventionStatus,
      preEvidenceId: item.preEvidenceId,
      postEvidenceId: item.postEvidenceId,
    })),
    createdAt: row.createdAt.toISOString(),
  }));
}

/** 按技能分组的活动证据（用于挂原始样本 / 前后测样本）。 */
export async function listBarrierEvidenceOptions(): Promise<BarrierEvidenceOptionsBySkill> {
  const rows = await prisma.evidenceRecord.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      skill: true,
      evidenceType: true,
      assistanceLevel: true,
      outputText: true,
      createdAt: true,
    },
  });

  const grouped: BarrierEvidenceOptionsBySkill = {};
  for (const row of rows) {
    const skill = row.skill as EvidenceSkill;
    const list = grouped[skill] ?? [];
    list.push({
      id: row.id,
      evidenceType: row.evidenceType as LearningEvidenceType,
      independent: row.assistanceLevel === 'A0',
      preview: previewOutput(row.outputText),
      createdAt: row.createdAt.toISOString(),
    });
    grouped[skill] = list;
  }
  return grouped;
}

export async function getBarrierStats(
  rows: readonly BarrierDiagnosisDto[],
): Promise<BarrierStats> {
  return summarizeBarriers(
    rows.map((row) => ({
      id: row.id,
      skill: row.skill,
      status: row.status,
      selectedFocus: row.selectedFocus,
      archived: row.archivedAt !== null,
    })),
  );
}
