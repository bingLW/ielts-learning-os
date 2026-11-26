/**
 * 快照溯源：这个版本当时「凭什么」生成 —— 针对哪个业务日、用哪版规则。
 *
 * 只读。快照被清理时显式说清后果：能恢复版本行，但无法复算当时的输入证据。
 */

import type { SnapshotProvenanceDto, VersionHistoryRowDto } from '@/lib/queries/planner';

const PURPOSE_LABEL: Record<string, string> = {
  GENERATE: '生成计划',
  REPLAN: '重排',
  WEEKLY: '周复盘',
  CYCLE_CALIBRATION: '周期校准',
};

export function SnapshotProvenance({
  version,
  snapshot,
}: {
  version: VersionHistoryRowDto | null;
  snapshot: SnapshotProvenanceDto | null;
}) {
  if (!version) {
    return (
      <p className="text-xs text-inkMuted" data-testid="snapshot-provenance">
        先从左侧选择「对照」版本，这里显示它引用的计划快照。
      </p>
    );
  }

  if (!version.snapshotId) {
    return (
      <div data-testid="snapshot-provenance" className="space-y-1 text-xs">
        <p className="text-ink">v{version.version}：该历史行没有记录快照。</p>
        <p className="text-inkMuted">
          早于快照机制的版本无法追溯原始输入；版本行本身仍完整、可对比。
        </p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div data-testid="snapshot-provenance" className="space-y-1 text-xs">
        <p className="font-medium text-amber-800" data-testid="snapshot-provenance-missing">
          v{version.version}：快照已清理
        </p>
        <p className="text-inkMuted">
          原始输入（画像、缺口、预算）已不在库中，无法复算当时的选择依据。
          版本行与任务仍保留；恢复会新建版本，但不会重建当时的快照。
        </p>
      </div>
    );
  }

  return (
    <dl data-testid="snapshot-provenance" className="grid gap-1 text-xs sm:grid-cols-2">
      <div>
        <dt className="text-[11px] text-inkMuted">版本</dt>
        <dd className="text-ink">
          v{version.version}（{version.planDate}）
        </dd>
      </div>
      <div>
        <dt className="text-[11px] text-inkMuted">快照业务日</dt>
        <dd className="text-ink">{snapshot.asOfDate}</dd>
      </div>
      <div>
        <dt className="text-[11px] text-inkMuted">用途</dt>
        <dd className="text-ink">{PURPOSE_LABEL[snapshot.purpose] ?? snapshot.purpose}</dd>
      </div>
      <div>
        <dt className="text-[11px] text-inkMuted">规则版本</dt>
        <dd className="text-ink">{snapshot.ruleVersion}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-[11px] text-inkMuted">快照 id</dt>
        <dd className="font-mono text-[11px] text-ink">{snapshot.id}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-[11px] text-inkMuted">快照创建时间</dt>
        <dd className="text-ink">{snapshot.createdAt.slice(0, 16).replace('T', ' ')}</dd>
      </div>
    </dl>
  );
}