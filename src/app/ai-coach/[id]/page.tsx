/**
 * `/ai-coach/[id]` 会话工作台。
 */

import { notFound } from 'next/navigation';
import { AiSessionWorkspace } from '@/components/ai-coach/AiSessionWorkspace';
import { getAiSessionDetail } from '@/lib/queries/tutor';

export const dynamic = 'force-dynamic';

export default async function AiSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getAiSessionDetail(id);
  if (!data) notFound();

  const session = data.session;
  return (
    <AiSessionWorkspace
      session={{
        id: session.id,
        mode: session.mode,
        skill: session.skill,
        objective: session.objective,
        targetLevel: session.targetLevel,
        status: session.status,
        provider: session.provider,
        model: session.model,
        baselineText: session.baselineText,
        taskSpecJson: session.taskSpecJson,
        estimatedCostUsd: session.estimatedCostUsd,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        directTeaching: session.directTeaching,
        failureReason: session.failureReason,
        createdAt: session.createdAt,
        completedAt: session.completedAt,
      }}
      turns={data.turns}
      evidence={data.evidence.map((item) => ({
        id: item.id,
        evidenceType: item.evidenceType,
        score: item.score,
        assistanceLevel: item.assistanceLevel,
        assessorType: item.assessorType,
        note: item.note,
        createdAt: item.createdAt,
      }))}
      maxHintLevel={data.maxHintLevel}
      pendingRetests={data.pendingRetests}
    />
  );
}