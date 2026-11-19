/**
 * AI 使用日志查询（近 30 天）。
 *
 * 统计口径：A4 依赖占比只用于提醒「是否把产出交给 AI」，
 * 不是语言能力指标。
 */

import { AI_USAGE_RECENT_DAYS, AI_USAGE_RECENT_LIMIT } from '@/lib/constants';
import { aiUsageIndependent, summarizeAiUsage, type AiUsageStats } from '@/lib/domain/coach';
import { previewOutput } from '@/lib/domain/evidence';
import { prisma } from '@/lib/prisma';
import type {
  AdoptionStatus,
  AIActionType,
  AiUsageRecordDto,
  AssistanceLevel,
  EvidenceSkill,
} from '@/lib/types';

export async function listRecentAiUsage(): Promise<AiUsageRecordDto[]> {
  const cutoff = new Date(Date.now() - AI_USAGE_RECENT_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.aIUsageRecord.findMany({
    where: { createdAt: { gte: cutoff } },
    orderBy: { createdAt: 'desc' },
    take: AI_USAGE_RECENT_LIMIT,
    include: {
      evidence: { select: { skill: true, outputText: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    toolName: row.toolName,
    modelVersion: row.modelVersion,
    assistanceLevel: row.assistanceLevel as AssistanceLevel,
    actionType: row.actionType as AIActionType,
    purpose: row.purpose,
    inputRef: row.inputRef,
    outputRef: row.outputRef,
    adoptedOrRejected: row.adoptedOrRejected as AdoptionStatus,
    independent: aiUsageIndependent(
      row.assistanceLevel as AssistanceLevel,
      row.actionType as AIActionType,
    ),
    evidenceId: row.evidenceId,
    evidenceSkill: row.evidence ? (row.evidence.skill as EvidenceSkill) : null,
    evidencePreview: row.evidence ? previewOutput(row.evidence.outputText) : null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export function getAiUsageStats(rows: readonly AiUsageRecordDto[]): AiUsageStats {
  return summarizeAiUsage(rows);
}
