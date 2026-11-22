/**
 * `/materials/[id]/source` 来源与权限（T13）。
 *
 * 页面只负责取数与布局：受限判定、留痕写入、来源更新都在 action 里
 * （`RightsWarningBanner` 与 action 共用同一套判断口径，避免"页面说可以、
 * 点下去被拒"）。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MaterialStatusBadge } from '@/components/materials/MaterialStatusBadge';
import { SourceDetailsBody } from '@/components/materials/SourceDetailsBody';
import type { MaterialStatus } from '@/lib/constants';
import {
  getMaterialSource,
  getMaterialStatus,
  listMaterialPermissionRecords,
} from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors';

export default async function MaterialSourcePage({ params }: PageProps) {
  const { id } = await params;

  const [status, source, records] = await Promise.all([
    getMaterialStatus(id),
    getMaterialSource(id),
    listMaterialPermissionRecords(id),
  ]);
  if (!status || !source) notFound();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h1 className="truncate text-base font-semibold text-ink">{status.title}</h1>
            <MaterialStatusBadge status={status.status as MaterialStatus} />
          </div>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            来源与权限 · 来源不明或订阅访问的材料禁止导出，每次拦截都会留痕
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/materials/${id}`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            返回材料详情
          </Link>
          <Link
            href="/materials"
            className={`${LINK_CLASS} border-transparent text-inkMuted hover:bg-surfaceAlt hover:text-ink`}
          >
            材料库
          </Link>
        </div>
      </div>

      <SourceDetailsBody materialId={id} source={source} records={records} />
    </div>
  );
}
