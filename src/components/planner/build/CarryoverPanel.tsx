import { MODULE_META } from '@/lib/constants';
import type { CarryoverDecisionView, CarryoverPreview } from '@/lib/domain/carryover';
import type { ModuleId } from '@/lib/types';

const GROUPS: { action: CarryoverDecisionView['action']; title: string }[] = [
  { action: 'PROMOTE', title: '今日纳入' },
  { action: 'DEMOTE', title: '降低优先级后纳入' },
  { action: 'BACKLOG', title: '进入 Backlog' },
  { action: 'ABANDON', title: '本次放弃（保留历史）' },
];

export function CarryoverPanel({ carryover }: { carryover: CarryoverPreview | null }) {
  if (!carryover) return null;
  return (
    <section data-testid="carryover-preview" className="rounded-md border border-line bg-surfaceAlt/40 p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink">上期未完成任务处理</h3>
        <p className="text-[11px] text-inkMuted">
          纳入 {carryover.promotedCount + carryover.demotedCount} · Backlog {carryover.backlogCount} · 放弃 {carryover.abandonedCount}
        </p>
      </div>
      {carryover.decisions.length === 0 ? (
        <p className="mt-1 text-[11px] text-inkMuted">没有符合滚存条件的上期任务。</p>
      ) : (
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {GROUPS.map((group) => {
            const rows = carryover.decisions.filter((decision) => decision.action === group.action);
            return (
              <div key={group.action} className="rounded border border-line/70 bg-white px-2 py-1.5">
                <h4 className="text-[11px] font-semibold text-ink">{group.title}（{rows.length}）</h4>
                {rows.length === 0 ? (
                  <p className="mt-0.5 text-[11px] text-inkMuted">无</p>
                ) : (
                  <ul className="mt-1 space-y-1.5">
                    {rows.map((decision) => (
                      <li key={decision.taskId} className="text-[11px] text-ink">
                        <p className="font-medium">
                          {MODULE_META[decision.module as ModuleId]?.labelZh ?? decision.module} · {decision.taskId.slice(0, 12)}
                        </p>
                        <p className="text-inkMuted">{decision.reason}</p>
                        <p className="text-inkMuted">
                          原安排 {decision.originalDate} · 上次计划 {decision.previousPlanDate} / v{decision.previousPlanVersion}
                          {' '}· 原优先级 {decision.previousPriority} · 已滚存 {decision.movedCount} 次
                        </p>
                        <p className="text-inkMuted">
                          计划 {decision.plannedMinutes} 分钟 · 已完成 {decision.actualMinutes} 分钟 · 本次剩余 {decision.remainingMinutes} 分钟
                        </p>
                        <p>最终去向：{decision.destination}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
