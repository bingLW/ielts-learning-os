/**
 * Evidence Center 只读查询。
 *
 * 只做读取与 DTO 映射：证据一旦保存就是原始样本，页面不提供覆盖式编辑。
 */

import { parseEvidenceCondition, previewOutput, summarizeEvidence } from '@/lib/domain/evidence';
import { parseObject } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type {
  AssistanceLevel,
  AssessorType,
  EvidenceConfidence,
  EvidenceDetailDto,
  EvidenceLevel,
  EvidencePrivacy,
  EvidenceRowDto,
  EvidenceSkill,
  LearningEvidenceType,
} from '@/lib/types';
import type { EvidenceStats } from '@/lib/domain/evidence';

export interface EvidenceFilter {
  skill?: EvidenceSkill | 'ALL';
  evidenceType?: LearningEvidenceType | 'ALL';
  level?: EvidenceLevel | 'ALL';
  includeArchived?: boolean;
  limit?: number;
}

function toRow(record: {
  id: string;
  skill: string;
  evidenceType: string;
  level: string;
  parentEvidenceId: string | null;
  chainRootId: string | null;
  outputText: string | null;
  score: number | null;
  scoreReason: string | null;
  evidenceAnchor: string | null;
  assistanceLevel: string;
  assessorType: string;
  confidence: string;
  privacyLevel: string;
  note: string | null;
  conditionJson: string | null;
  dimensionsJson: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  artifactId: string | null;
  _count?: { children: number };
}): EvidenceRowDto {
  return {
    id: record.id,
    skill: record.skill as EvidenceSkill,
    evidenceType: record.evidenceType as LearningEvidenceType,
    level: record.level as EvidenceLevel,
    parentEvidenceId: record.parentEvidenceId,
    chainRootId: record.chainRootId,
    outputPreview: previewOutput(record.outputText),
    score: record.score,
    scoreReason: record.scoreReason,
    evidenceAnchor: record.evidenceAnchor,
    assistanceLevel: record.assistanceLevel as AssistanceLevel,
    independent: record.assistanceLevel === 'A0',
    assessorType: record.assessorType as AssessorType,
    confidence: record.confidence as EvidenceConfidence,
    hasArtifact: record.artifactId !== null,
    childCount: record._count?.children ?? 0,
    archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
  };
}

/** 证据列表（默认按创建时间倒序；归档默认不显示）。 */
export async function listEvidence(filter: EvidenceFilter = {}): Promise<EvidenceRowDto[]> {
  const where: Record<string, unknown> = {};
  if (filter.includeArchived !== true) where.archivedAt = null;
  if (filter.skill && filter.skill !== 'ALL') where.skill = filter.skill;
  if (filter.evidenceType && filter.evidenceType !== 'ALL') where.evidenceType = filter.evidenceType;
  if (filter.level && filter.level !== 'ALL') where.level = filter.level;

  const rows = await prisma.evidenceRecord.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: filter.limit && filter.limit > 0 ? filter.limit : undefined,
    include: { _count: { select: { children: true } } },
  });
  return rows.map((row) => toRow(row));
}

/** 证据详情列表（Evidence Center 一次加载；个人数据量级下 N+1 可接受）。 */
export async function listEvidenceDetails(
  filter: EvidenceFilter = {},
): Promise<EvidenceDetailDto[]> {
  const rows = await listEvidence(filter);
  const details = await Promise.all(rows.map((row) => getEvidenceDetail(row.id)));
  return details.filter((item): item is EvidenceDetailDto => item !== null);
}

/** 证据详情（含条件快照、维度、附件与链关系）。 */
export async function getEvidenceDetail(id: string): Promise<EvidenceDetailDto | null> {
  const record = await prisma.evidenceRecord.findUnique({
    where: { id },
    include: {
      _count: { select: { children: true } },
      artifact: true,
      parent: { select: { id: true, evidenceType: true, createdAt: true } },
      children: {
        select: { id: true, evidenceType: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!record) return null;

  return {
    ...toRow(record),
    condition: parseEvidenceCondition(record.conditionJson),
    dimensions: parseObject<Record<string, number>>(record.dimensionsJson, {}),
    outputText: record.outputText,
    privacyLevel: record.privacyLevel as EvidencePrivacy,
    note: record.note,
    artifact: record.artifact
      ? {
          id: record.artifact.id,
          fileUri: record.artifact.fileUri,
          mimeType: record.artifact.mimeType,
          evidenceType: record.artifact.evidenceType,
          privacyLevel: record.artifact.privacyLevel as EvidencePrivacy,
          consentStatus: record.artifact.consentStatus,
        }
      : null,
    parent: record.parent
      ? {
          id: record.parent.id,
          evidenceType: record.parent.evidenceType as LearningEvidenceType,
          createdAt: record.parent.createdAt.toISOString(),
        }
      : null,
    children: record.children.map((child) => ({
      id: child.id,
      evidenceType: child.evidenceType as LearningEvidenceType,
      createdAt: child.createdAt.toISOString(),
    })),
  };
}

/** 证据覆盖统计（只数活动证据，不算能力分数）。 */
export async function getEvidenceStats(): Promise<EvidenceStats> {
  const rows = await prisma.evidenceRecord.findMany({
    select: {
      skill: true,
      evidenceType: true,
      assistanceLevel: true,
      archivedAt: true,
    },
  });
  return summarizeEvidence(
    rows.map((row) => ({
      skill: row.skill as EvidenceSkill,
      evidenceType: row.evidenceType as LearningEvidenceType,
      assistanceLevel: row.assistanceLevel as AssistanceLevel,
      archived: row.archivedAt !== null,
    })),
  );
}

export interface EvidencePickerOption {
  id: string;
  skill: EvidenceSkill;
  evidenceType: LearningEvidenceType;
  independent: boolean;
  preview: string | null;
  createdAt: string;
}

/** 跨技能的活动证据选项（AI 日志、Coach 等页面挂证据用）。 */
export async function listEvidencePickerOptions(): Promise<EvidencePickerOption[]> {
  const rows = await prisma.evidenceRecord.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true,
      skill: true,
      evidenceType: true,
      assistanceLevel: true,
      outputText: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    skill: row.skill as EvidenceSkill,
    evidenceType: row.evidenceType as LearningEvidenceType,
    independent: row.assistanceLevel === 'A0',
    preview: previewOutput(row.outputText),
    createdAt: row.createdAt.toISOString(),
  }));
}
