/**
 * 30 天结构视图：渲染 `PlanVersion.afterSnapshot` 的 8 项结构（AC-4）。
 *
 * **不读 `WeeklyFocus`**：后者是「每周主问题」，看起来像阶段计划，
 * 但它不是 30 天层的产物；读错表会让 8 项结构在无 WeeklyFocus 时整块消失。
 */

import type { PlanLayerStructure } from '@/lib/services/planBuild';

const SKILL_LABEL: Record<string, string> = {
  LISTENING: '听力',
  READING: '阅读',
  SPEAKING: '口语',
  WRITING: '写作',
};

function Item({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div data-structure-item={index} className="rounded-md border border-line px-2.5 py-2">
      <p className="text-[11px] font-semibold text-ink">
        {index}. {title}
      </p>
      <div className="mt-0.5 text-[11px] text-inkMuted">{children}</div>
    </div>
  );
}

export function ThirtyDayMatrix({ structure }: { structure: PlanLayerStructure }) {
  return (
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      <Item index={1} title="阶段目标">
        {structure.stageGoal}
      </Item>
      <Item index={2} title="周里程碑">
        <ul className="space-y-0.5">
          {structure.weeklyMilestones.map((milestone) => (
            <li key={milestone.week}>
              第 {milestone.week} 周（{milestone.startDate}）：{milestone.goal}
            </li>
          ))}
        </ul>
      </Item>
      <Item index={3} title="技能配比">
        {Object.entries(structure.skillAllocation)
          .map(([skill, ratio]) => `${SKILL_LABEL[skill] ?? skill} ${ratio}%`)
          .join(' · ')}
      </Item>
      <Item index={4} title="每周测试">
        {structure.weeklyTests}
      </Item>
      <Item index={5} title="材料建议">
        {structure.materialSuggestions}
      </Item>
      <Item index={6} title="词汇语法范围">
        {structure.vocabGrammarScope}
      </Item>
      <Item index={7} title="验收指标">
        {structure.acceptanceCriteria}
      </Item>
      <Item index={8} title="调整条件">
        {structure.adjustmentConditions}
      </Item>
    </div>
  );
}