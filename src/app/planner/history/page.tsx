/**
 * `/planner/history`（v2.7 T13）：版本时间线 + 两版差异 + 快照溯源。
 *
 * 对比对象由 `?before=&after=` 决定；都缺省时自动取「同一计划日下最新的一对」，
 * 避免每次都让用户先点两下。恢复入口始终是「新建版本」，见 `RestoreDialog`。
 */

import { isValidDateString } from '@/lib/date';
import {
  getSnapshotProvenanceMap,
  getVersionDiff,
  getVersionHistory,
  type VersionHistoryRowDto,
} from '@/lib/queries/planner';
import { VersionHistoryBody } from '@/components/planner/history/VersionHistoryBody';
import type { RawSearchParams } from '@/lib/queries/filters';

export const dynamic = 'force-dynamic';

const LAYERS = ['ALL', 'DAY', 'WEEK', 'MONTH', 'CYCLE'] as const;
type LayerFilter = (typeof LAYERS)[number];

function one(params: RawSearchParams, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function parseLayer(params: RawSearchParams): LayerFilter {
  const raw = one(params, 'layer');
  return (LAYERS as readonly string[]).includes(raw) ? (raw as LayerFilter) : 'ALL';
}

function parseDate(params: RawSearchParams, key: string): string {
  const raw = one(params, key);
  return isValidDateString(raw) ? raw : '';
}

/** 同一计划日下版本号相邻的一对（较旧 = 基准，较新 = 对照）。 */
function defaultPair(rows: VersionHistoryRowDto[]): { before: string | null; after: string | null } {
  const groups = new Map<string, VersionHistoryRowDto[]>();
  for (const row of rows) {
    const group = groups.get(row.planDate);
    if (group) group.push(row);
    else groups.set(row.planDate, [row]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.version - b.version);
    const after = sorted[sorted.length - 1];
    const before = sorted[sorted.length - 2];
    return { before: before.id, after: after.id };
  }
  return { before: null, after: null };
}

function pairInSameDate(
  rows: VersionHistoryRowDto[],
  id: string,
  role: 'before' | 'after',
): string | null {
  const target = rows.find((row) => row.id === id);
  if (!target) return null;
  const candidates = rows
    .filter((row) => row.planDate === target.planDate && row.id !== target.id)
    .sort((a, b) => a.version - b.version);
  if (role === 'before') {
    // 基准已定 → 对照取同计划日里更大的版本
    return candidates.find((row) => row.version > target.version)?.id ?? null;
  }
  // 对照已定 → 基准取同计划日里更小的版本
  const smaller = candidates.filter((row) => row.version < target.version);
  return smaller.length > 0 ? smaller[smaller.length - 1].id : null;
}

export default async function PlannerHistoryPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const layer = parseLayer(params);
  const from = parseDate(params, 'from');
  const to = parseDate(params, 'to');

  const rows = await getVersionHistory({
    layer,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: 50,
  });

  const ids = new Set(rows.map((row) => row.id));
  const fallback = defaultPair(rows);
  let beforeId = one(params, 'before') || null;
  let afterId = one(params, 'after') || null;
  if (beforeId && !ids.has(beforeId)) beforeId = null;
  if (afterId && !ids.has(afterId)) afterId = null;

  if (!beforeId && !afterId) {
    beforeId = fallback.before;
    afterId = fallback.after;
  } else if (beforeId && !afterId) {
    afterId = pairInSameDate(rows, beforeId, 'before');
  } else if (!beforeId && afterId) {
    beforeId = pairInSameDate(rows, afterId, 'after');
  } else if (beforeId === afterId) {
    beforeId = fallback.before;
    afterId = fallback.after;
  }

  const [snapshots, diff] = await Promise.all([
    getSnapshotProvenanceMap(rows.map((row) => row.snapshotId ?? '')),
    beforeId && afterId ? getVersionDiff(beforeId, afterId) : Promise.resolve(null),
  ]);

  return (
    <VersionHistoryBody
      rows={rows}
      snapshots={snapshots}
      diff={diff}
      beforeId={beforeId}
      afterId={afterId}
      filter={{ layer, from, to }}
    />
  );
}