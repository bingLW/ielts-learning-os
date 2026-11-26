/**
 * `/planner/history` 主体：筛选 + 时间线 + 三栏差异 + 快照溯源。
 *
 * 服务端只渲染；选择「基准/对照」走 URL 查询参数，刷新/分享/后退结果一致。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import type {
  SnapshotProvenanceDto,
  VersionDiffDto,
  VersionHistoryRowDto,
} from '@/lib/queries/planner';
import { SnapshotProvenance } from './SnapshotProvenance';
import { VersionDiffView } from './VersionDiffView';
import { VersionTimeline } from './VersionTimeline';

const LAYER_OPTIONS: { value: string; label: string }[] = [
  { value: 'ALL', label: '全部层级' },
  { value: 'DAY', label: '日计划' },
  { value: 'WEEK', label: '周计划' },
  { value: 'MONTH', label: '月计划' },
  { value: 'CYCLE', label: '90 天周期' },
];

export interface VersionHistoryFilterView {
  layer: string;
  from: string;
  to: string;
}

export function VersionHistoryBody({
  rows,
  snapshots,
  diff,
  beforeId,
  afterId,
  filter,
}: {
  rows: VersionHistoryRowDto[];
  snapshots: Record<string, SnapshotProvenanceDto>;
  diff: VersionDiffDto | null;
  beforeId: string | null;
  afterId: string | null;
  filter: VersionHistoryFilterView;
}) {
  const base = new URLSearchParams();
  if (filter.layer !== 'ALL') base.set('layer', filter.layer);
  if (filter.from) base.set('from', filter.from);
  if (filter.to) base.set('to', filter.to);

  const linkFor = (versionId: string, role: 'before' | 'after') => {
    const params = new URLSearchParams(base);
    if (beforeId) params.set('before', beforeId);
    if (afterId) params.set('after', afterId);
    params.set(role, versionId);
    return `/planner/history?${params.toString()}`;
  };

  const afterVersion = afterId ? (rows.find((row) => row.id === afterId) ?? null) : null;
  const afterSnapshot =
    afterVersion?.snapshotId ? (snapshots[afterVersion.snapshotId] ?? null) : null;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">版本历史</h1>
          <p className="text-xs text-inkMuted">
            计划版本 append-only：恢复只新建版本，不改写下面任何一行 · 共 {rows.length} 条
          </p>
        </div>
        <Link href="/planner/build" className="text-xs text-brand">
          去构建计划
        </Link>
      </header>

      <Card title="筛选" description="按层级与计划日过滤；对比选择不受筛选影响，但会随过滤后的列表重新校验">
        <form method="get" action="/planner/history" className="flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] text-inkMuted">层级</span>
            <select
              name="layer"
              defaultValue={filter.layer}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              {LAYER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] text-inkMuted">从（计划日）</span>
            <input
              type="date"
              name="from"
              defaultValue={filter.from}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] text-inkMuted">到（计划日）</span>
            <input
              type="date"
              name="to"
              defaultValue={filter.to}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            />
          </label>
          <button
            type="submit"
            className="rounded-md border border-line bg-white px-2.5 py-1 text-xs text-ink hover:bg-surfaceAlt"
          >
            应用筛选
          </button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <Card title="还没有任何版本">
          <p data-testid="history-empty" className="text-xs text-inkMuted">
            当前筛选下没有计划版本。先生成一份计划，版本会随生成/重排/恢复自动累积。
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card title="版本时间线" description="最近 50 条；点「设为基准 / 设为对照」比较两版">
            <VersionTimeline
              rows={rows}
              snapshots={snapshots}
              beforeId={beforeId}
              afterId={afterId}
              linkFor={linkFor}
            />
          </Card>

          <div className="space-y-3">
            <Card title="版本对比（计划分钟）" description="只比计划，不比实际 —— 实际是事实，不随版本变化">
              <VersionDiffView diff={diff} />
            </Card>

            <Card title="快照溯源" description="对照版本当时针对的业务日与规则版本">
              <SnapshotProvenance version={afterVersion} snapshot={afterSnapshot} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}