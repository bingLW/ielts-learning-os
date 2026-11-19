/**
 * `/stages` 阶段与验收。
 */

import type { AcceptanceItemDto, GateResult } from '@/lib/types';
import {
  getActiveStage,
  getStageGate,
  listAcceptanceItems,
  listStageTimeline,
  listTransitionLogs,
} from '@/lib/queries/stages';
import { getGoalCards } from '@/lib/queries/goals';
import { StagesPageBody } from '@/components/stages/StagesPageBody';

export const dynamic = 'force-dynamic';

export default async function StagesPage() {
  const [stages, activeStage, logs, trackGoals] = await Promise.all([
    listStageTimeline(),
    getActiveStage(),
    listTransitionLogs(10),
    getGoalCards(),
  ]);

  let acceptance: AcceptanceItemDto[] = [];
  let gate: GateResult | null = null;
  if (activeStage) {
    const results = await Promise.all([
      listAcceptanceItems(activeStage.id),
      getStageGate(activeStage.id),
    ]);
    acceptance = results[0];
    gate = results[1];
  }

  return (
    <StagesPageBody
      stages={stages}
      activeStageId={activeStage?.id ?? null}
      activeStageName={activeStage?.nameZh ?? '未激活阶段'}
      acceptance={acceptance}
      gate={gate}
      logs={logs.map((log) => ({
        id: log.id,
        fromStageCode: log.fromStageCode,
        toStageCode: log.toStageCode,
        decidedAt: log.decidedAt.toISOString(),
        decidedBy: log.decidedBy,
        reason: log.reason,
      }))}
      trackGoals={trackGoals}
    />
  );
}
