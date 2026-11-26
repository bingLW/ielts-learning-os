import { toBusinessDate } from '@/lib/date';
import {
  buildDiagnosticProposalCandidates,
  diagnosticProposalFingerprint,
} from '@/lib/diagnostic/planProposal';
import type { TaskCandidateDraft } from '@/lib/domain/taskCandidate';
import { prisma } from '@/lib/prisma';
import { fail, ok } from '@/lib/result';
import type { ActionResult } from '@/lib/types';

export interface DiagnosticProposalSource {
  id: string;
  fingerprint: string;
  window: '7D';
  taskCount: number;
  candidates: TaskCandidateDraft[];
}

export async function loadDiagnosticProposal(input: {
  proposalId: string;
  asOfDate: string;
  timeZone: string;
  minTaskMinutes: number;
}): Promise<ActionResult<DiagnosticProposalSource>> {
  if (input.asOfDate.length === 0) return fail('VALIDATION', '诊断草案预览缺少业务基准日');

  const proposal = await prisma.planProposal.findUnique({
    where: { id: input.proposalId },
    select: {
      id: true,
      reportId: true,
      status: true,
      tasksJson: true,
      report: { select: { status: true, createdAt: true } },
    },
  });
  if (!proposal) return fail('NOT_FOUND', '诊断计划草案不存在');
  if (proposal.status !== 'DRAFT') {
    return fail('PRECONDITION', '诊断计划草案已启用或归档，不能再次预览');
  }
  if (proposal.report.status === 'SUPERSEDED') {
    return fail('PRECONDITION', '诊断报告已被新报告取代，请使用新报告的计划草案');
  }

  const generatedBusinessDate = toBusinessDate(proposal.report.createdAt, input.timeZone);
  if (generatedBusinessDate !== input.asOfDate) {
    return fail(
      'PRECONDITION',
      `诊断草案生成于 ${generatedBusinessDate}，与当前业务基准日 ${input.asOfDate} 不一致；草案已过期，请重新生成诊断计划`,
    );
  }

  const fingerprint = diagnosticProposalFingerprint({
    id: proposal.id,
    status: proposal.status,
    asOfDate: input.asOfDate,
    tasksJson: proposal.tasksJson,
  });

  try {
    const candidates = buildDiagnosticProposalCandidates({
      proposalId: proposal.id,
      reportId: proposal.reportId,
      asOfDate: input.asOfDate,
      horizonDays: 7,
      minTaskMinutes: input.minTaskMinutes,
      tasks: proposal.tasksJson,
    });
    if (candidates.length === 0) {
      return fail('PRECONDITION', '诊断草案的 7 天启动阶段没有可排任务');
    }
    return ok({ id: proposal.id, fingerprint, window: '7D', taskCount: candidates.length, candidates });
  } catch (error) {
    return fail(
      'VALIDATION',
      `诊断计划草案内容无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
