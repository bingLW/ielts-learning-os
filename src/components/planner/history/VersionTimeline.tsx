/**
 * 版本时间线（`/planner/history`）：append-only 的版本行，冻结行不提供任何「改写」入口。
 *
 * 每行必须能回答五件事：版本号、来源、原因、预算、AI 是否参与（T13 ⑪）；
 * 快照状态单独给出，因为「快照已清理」决定恢复是否可用（T13 ⑭）。
 */

import Link from 'next/link';
import type { SnapshotProvenanceDto, VersionHistoryRowDto } from '@/lib/queries/planner';
import { RestoreDialog } from './RestoreDialog';

const LAYER_LABEL: Record<string, string> = {
  DAY: '日计划',
  WEEK: '周计划',
  MONTH: '月计划',
  CYCLE: '90 天周期',
};

const SOURCE_LABEL: Record<string, string> = {
  GENERATE: '生成',
  REPLAN: '重排',
  MANUAL_ADJUST: '手动调整',
};

function snapshotStatus(
  row: VersionHistoryRowDto,
  snapshots: Record<string, SnapshotProvenanceDto>,
): string {
  if (!row.snapshotId) return '无快照（该历史行未记录）';
  const snapshot = snapshots[row.snapshotId];
  return snapshot ? `已记录（${snapshot.asOfDate} · ${snapshot.ruleVersion}）` : '快照已清理';
}

export function VersionTimeline({
  rows,
  snapshots,
  beforeId,
  afterId,
  linkFor,
}: {
  rows: VersionHistoryRowDto[];
  snapshots: Record<string, SnapshotProvenanceDto>;
  beforeId: string | null;
  afterId: string | null;
  linkFor: (versionId: string, role: 'before' | 'after') => string;
}) {
  return (
    <ol data-testid="version-timeline" className="space-y-2">
      {rows.map((row) => {
        const isBefore = row.id === beforeId;
        const isAfter = row.id === afterId;
        const cleaned = Boolean(row.snapshotId) && !snapshots[row.snapshotId as string];
        return (
          <li
            key={row.id}
            data-testid="version-row"
            data-version={row.version}
            data-layer={row.layer}
            className={[
              'rounded-md border px-3 py-2',
              isBefore || isAfter ? 'border-brand bg-blue-50/40' : 'border-line bg-surface',
            ].join(' ')}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-ink">
                v{row.version} · {LAYER_LABEL[row.layer]} · 计划日 {row.planDate}
              </p>
              <span className="flex items-center gap-2 text-[11px]">
                {isBefore && <span className="text-brand">基准</span>}
                {isAfter && <span className="text-brand">对照</span>}
                <Link href={linkFor(row.id, 'before')} className="text-brand">
                  设为基准
                </Link>
                <Link href={linkFor(row.id, 'after')} className="text-brand">
                  设为对照
                </Link>
                <Link href={`/planner/explain/${row.id}`} className="text-brand">
                  解释
                </Link>
              </span>
            </div>

            <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-[11px] text-inkMuted sm:grid-cols-2">
              <div>
                <dt className="inline">来源：</dt>
                <dd className="inline text-ink">{SOURCE_LABEL[row.changeSource] ?? row.changeSource}</dd>
              </div>
              <div>
                <dt className="inline">预算：</dt>
                <dd className="inline text-ink">{row.budgetMinutes} 分钟</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="inline">原因：</dt>
                <dd className="inline text-ink">{row.reason?.trim() || '未填写'}</dd>
              </div>
              <div>
                <dt className="inline">AI 参与：</dt>
                <dd className="inline text-ink">{row.aiInvolved ? '是' : '否（规则生成）'}</dd>
              </div>
              <div>
                <dt className="inline">快照：</dt>
                <dd
                  className={cleaned ? 'inline text-amber-800' : 'inline text-ink'}
                  data-testid={cleaned ? 'snapshot-cleaned' : undefined}
                >
                  {snapshotStatus(row, snapshots)}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="inline">创建于：</dt>
                <dd className="inline text-ink">
                  {row.createdAt.slice(0, 16).replace('T', ' ')}
                  {row.staleAt ? ' · 已过期' : ''}
                </dd>
              </div>
            </dl>

            <div className="mt-1.5">
              <RestoreDialog
                versionId={row.id}
                version={row.version}
                layer={row.layer}
                hasSnapshotId={Boolean(row.snapshotId)}
                snapshotAvailable={Boolean(row.snapshotId && snapshots[row.snapshotId])}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}