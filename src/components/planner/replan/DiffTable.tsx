/**
 * 重排 diff 表：任务 / 重排前 / 重排后 三列。
 *
 * 六类行标记（ADD / REMOVE / MOVE / RESIZE / PRIORITY_CHANGE / KEEP）都显式写出，
 * 不用颜色单独承载语义；受保护行标「不会被改写」。
 */

import type { ReplanDiffEntry } from '@/lib/domain/planDiff';

const KIND_LABEL: Record<ReplanDiffEntry['kind'], string> = {
  ADD: '新增',
  REMOVE: '移除',
  MOVE: '改期',
  RESIZE: '调整时长',
  PRIORITY_CHANGE: '调优先级',
  KEEP: '保持不变',
};

const KIND_CLASS: Record<ReplanDiffEntry['kind'], string> = {
  ADD: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  REMOVE: 'border-red-300 bg-red-50 text-red-700',
  MOVE: 'border-blue-300 bg-blue-50 text-blue-800',
  RESIZE: 'border-violet-300 bg-violet-50 text-violet-800',
  PRIORITY_CHANGE: 'border-amber-300 bg-amber-50 text-amber-900',
  KEEP: 'border-line bg-surfaceAlt text-inkMuted',
};

function Cell({ side }: { side: ReplanDiffEntry['before'] | ReplanDiffEntry['after'] }) {
  if (!side) return <span className="text-inkMuted">—（不在当日计划）</span>;
  return (
    <span>
      {side.date}
      <span className="ml-1 text-inkMuted">
        · {side.priority} · {side.minutes} 分钟
      </span>
    </span>
  );
}

export function DiffTable({ entries }: { entries: ReplanDiffEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-line text-[11px] text-inkMuted">
            <th className="py-1 pr-2 font-medium">标记</th>
            <th className="py-1 pr-2 font-medium">任务</th>
            <th className="py-1 pr-2 font-medium">重排前</th>
            <th className="py-1 pr-2 font-medium">重排后</th>
            <th className="py-1 font-medium">原因</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.key} data-kind={entry.kind} className="border-b border-line/60 align-top">
              <td className="py-1 pr-2">
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${KIND_CLASS[entry.kind]}`}
                >
                  {KIND_LABEL[entry.kind]}
                </span>
              </td>
              <td className="py-1 pr-2 text-ink">
                {entry.title}
                {entry.protected && <span className="ml-1 text-[10px] text-inkMuted">· 不会被改写</span>}
              </td>
              <td className="py-1 pr-2 text-ink">
                <Cell side={entry.before} />
              </td>
              <td className="py-1 pr-2 text-ink">
                <Cell side={entry.after} />
              </td>
              <td className="py-1 text-[11px] text-inkMuted">{entry.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}