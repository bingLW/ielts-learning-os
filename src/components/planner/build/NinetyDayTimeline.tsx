/**
 * 90 天周期视图：时间线 + 8 项结构 + 固定免责文案。
 *
 * 免责文案是**界面常量**而不是可编辑内容：90 天展望最容易被读成「承诺」。
 */

import { DISCLAIMER_CEFR } from '@/lib/constants';
import type { PlanLayerStructure } from '@/lib/services/planBuild';
import { ThirtyDayMatrix } from './ThirtyDayMatrix';

export function NinetyDayTimeline({ structure }: { structure: PlanLayerStructure }) {
  return (
    <div className="space-y-2">
      <ol className="space-y-1">
        {structure.weeklyMilestones.map((milestone) => (
          <li key={milestone.week} className="flex items-start gap-2 text-[11px]">
            <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full border border-brand bg-white" />
            <span>
              <span className="font-medium text-ink">第 {milestone.week} 周</span>
              <span className="ml-1 text-inkMuted">
                {milestone.startDate} · {milestone.goal}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <ThirtyDayMatrix structure={structure} />
      <p data-testid="cycle-disclaimer" className="rounded-md bg-surfaceAlt px-2.5 py-1.5 text-[11px] text-inkMuted">
        {DISCLAIMER_CEFR} 90 天周期是规划展望：它描述练习路径与验收方式，不承诺分数提升，也不代替官方测评。
      </p>
    </div>
  );
}