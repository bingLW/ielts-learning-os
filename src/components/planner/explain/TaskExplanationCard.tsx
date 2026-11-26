/**
 * 单条任务解释卡：8 个要素逐条显式渲染，缺数据时写「未记录 / 无法判断」，
 * **不留空白**（空字段会被读成「没有理由」，而实际是「没记下来」）。
 *
 * 8 要素（docs/42 T12 ⑥）：①原因 ②目标 ③缺口引用 ④预计分钟 ⑤优先级
 * ⑥前置条件 ⑦产出 ⑧不做的影响。
 */

import { Card } from '@/components/ui/Card';
import { OriginBadge } from '../shared/OriginBadge';
import type { PlanExplanationTaskDto } from '@/lib/queries/planner';

const STATUS_LABEL: Record<string, string> = {
  TODO: '待做',
  IN_PROGRESS: '进行中',
  DONE: '已完成',
  PARTIAL: '部分完成',
  DEFERRED: '已延期',
  CANCELLED: '已取消',
  MISSED: '未完成',
};

function Field({ index, label, children }: { index: number; label: string; children: React.ReactNode }) {
  return (
    <div data-explain-field={index} className="grid grid-cols-[92px_1fr] gap-2 py-1">
      <span className="text-[11px] text-inkMuted">
        {index}. {label}
      </span>
      <span className="text-xs text-ink">{children}</span>
    </div>
  );
}

export function TaskExplanationCard({
  task,
  goalRef,
}: {
  task: PlanExplanationTaskDto;
  goalRef: string | null;
}) {
  const explanation = task.explanation;
  return (
    <Card
      dense
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{task.moduleLabel}</span>
          <span className="text-[11px] font-normal text-inkMuted">
            {task.priorityLabel} · {STATUS_LABEL[task.status] ?? task.status} · 计划 {task.plannedMinutes} 分钟
            {task.actualMinutes > 0 ? ` · 实际 ${task.actualMinutes} 分钟` : ''}
          </span>
          <OriginBadge origin={explanation.origin} />
        </span>
      }
      description={`${task.skill} · 来源：${task.sourceLabel}`}
    >
      <div className="divide-y divide-line">
        <Field index={1} label="原因">
          {explanation.reason}
        </Field>
        <Field index={2} label="目标">
          {goalRef ?? '尚未设置学习目标'}
        </Field>
        <Field index={3} label="缺口引用">
          {explanation.gapRef ? (
            <span>
              {explanation.gapRef.skillGapKey}
              {explanation.gapRef.evidenceRefs.length === 0
                ? '（无证据引用）'
                : '：'}
              {explanation.gapRef.evidenceRefs.map((ref, index) => (
                <span key={ref}>
                  {index > 0 ? '、' : ''}
                  <a href={`?evidence=${encodeURIComponent(ref)}`} className="text-brand">
                    {ref.slice(0, 10)}
                  </a>
                </span>
              ))}
            </span>
          ) : (
            '无（该任务不绑定具体缺口）'
          )}
        </Field>
        <Field index={4} label="预计分钟">
          {explanation.estMinutes === null ? '预计分钟未记录' : `${explanation.estMinutes} 分钟`}
          {' · '}
          {explanation.minMinutes === null ? '最小单元未记录' : `最小 ${explanation.minMinutes} 分钟`}
        </Field>
        <Field index={5} label="优先级">
          {task.priorityLabel}
          {explanation.score !== null ? `（加权 ${explanation.score.toFixed(2)}）` : '（未记录加权分）'}
          {explanation.weightsVersion ? ` · 权重版本 ${explanation.weightsVersion}` : ''}
        </Field>
        <Field index={6} label="前置条件">
          {explanation.prerequisites.length === 0
            ? '无前置条件'
            : explanation.prerequisites.join('；')}
        </Field>
        <Field index={7} label="产出">
          {explanation.expectedOutput ?? '未记录（历史版本没有保存产出描述）'}
          {` · 措辞：${explanation.wordingSource === 'TEMPLATE' ? '模板生成' : 'AI 润色'}`}
        </Field>
        <Field index={8} label="不做的影响">
          {explanation.consequenceIfSkipped ?? '无法判断（系统不编造）'}
        </Field>
      </div>
    </Card>
  );
}