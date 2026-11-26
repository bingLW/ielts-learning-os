/**
 * 解释页主体：头部 + 逐条任务解释 + 结构（MONTH/CYCLE）+ 取舍 + AI 处置 + 证据抽屉。
 *
 * 证据抽屉由 `?evidence=` 驱动，服务端取好数据传入；组件层不取数（G-5③）。
 */

import { Card } from '@/components/ui/Card';
import { EvidenceDrawer } from '../shared/EvidenceDrawer';
import { ThirtyDayMatrix } from '../build/ThirtyDayMatrix';
import { NinetyDayTimeline } from '../build/NinetyDayTimeline';
import { AiDispositionPanel } from './AiDispositionPanel';
import { SnapshotHeader } from './SnapshotHeader';
import { TaskExplanationCard } from './TaskExplanationCard';
import { TradeoffPanel } from './TradeoffPanel';
import type { EvidenceDetailDto } from '@/lib/types';
import type { PlanExplanationDto } from '@/lib/queries/planner';

export function ExplanationBody({
  data,
  evidenceId,
  evidence,
}: {
  data: PlanExplanationDto;
  evidenceId: string | null;
  evidence: EvidenceDetailDto | null;
}) {
  const hasDailyTasks = data.layer === 'DAY' || data.layer === 'WEEK';

  return (
    <div className="space-y-3">
      <SnapshotHeader data={data} />

      {hasDailyTasks ? (
        <Card title={`任务解释（${data.tasks.length} 条）`} description="每一条都引用写出时的决策快照，不重算">
          {data.tasks.length === 0 ? (
            <p className="text-xs text-inkMuted">这一版没有任务（可能全部被预算挤掉或取消）。</p>
          ) : (
            <div className="space-y-2">
              {data.tasks.map((task) => (
                <TaskExplanationCard key={task.taskId} task={task} goalRef={data.goalRef} />
              ))}
            </div>
          )}
        </Card>
      ) : data.layerStructure ? (
        <Card
          title={data.layer === 'CYCLE' ? '90 天结构（8 项）' : '30 天结构（8 项）'}
          description="该层不排明细任务，验收对象就是这 8 项结构"
        >
          {data.layer === 'CYCLE' ? (
            <NinetyDayTimeline structure={data.layerStructure} />
          ) : (
            <ThirtyDayMatrix structure={data.layerStructure} />
          )}
        </Card>
      ) : (
        <Card title="结构">
          <p className="text-xs text-inkMuted">这一版没有可回放的 8 项结构（可能是旧版本或结构未写入）。</p>
        </Card>
      )}

      <TradeoffPanel tradeoffs={data.tradeoffs} />

      <AiDispositionPanel aiNote={data.aiNote} rejected={data.rejectedAiSuggestions} />

      {evidenceId && (
        <EvidenceDrawer
          evidenceId={evidenceId}
          evidence={evidence}
          closeHref={`/planner/explain/${data.versionId}`}
        />
      )}
    </div>
  );
}