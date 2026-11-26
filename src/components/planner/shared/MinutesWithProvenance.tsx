/**
 * 分钟数 + 口径前缀。**计划 / 实际净 两个口径永不互推**（I-1 / I-2）。
 *
 * 页面上任何裸数字都会被读成「今天练了多久」；这里强制带上口径，
 * 并给出 `title` 说明数值来源，避免「计划 90 分钟」被当成「已练 90 分钟」。
 */

export type MinutesKind = 'PLAN' | 'ACTUAL_NET';

const PREFIX: Record<MinutesKind, string> = {
  PLAN: '计划',
  ACTUAL_NET: '实际净',
};

const SOURCE_NOTE: Record<MinutesKind, string> = {
  PLAN: '计划分钟 = Σ PlanTask.plannedMinutes（排除 CANCELLED / DEFERRED）',
  ACTUAL_NET: '实际净分钟 = Σ StudySessionDaySplit.minutes（不含泛听泛读归类以外的折算）',
};

export function MinutesWithProvenance({
  kind,
  minutes,
  className,
}: {
  kind: MinutesKind;
  minutes: number;
  className?: string;
}) {
  return (
    <span className={['tabular', className].filter(Boolean).join(' ')} title={SOURCE_NOTE[kind]}>
      <span className="text-[11px] text-inkMuted">{PREFIX[kind]} </span>
      {minutes}
      <span className="text-[11px] text-inkMuted"> 分钟</span>
    </span>
  );
}