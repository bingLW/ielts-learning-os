/**
 * `/materials/[id]/read` 原文阅读 / 词汇辅助。
 *
 * Next 15 的动态参数与查询串都是 `Promise`，必须 `await`。
 *
 * 模式从 URL 决定（`?mode=original|vocab_assist`）：
 * - 缺省 / 无法识别 → `original`（**安全默认**：先看到纯原文）；
 * - `chunk` 参数只用于从审核页跳过来时定位闪烁，不参与任何数据查询。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DocumentReader } from '@/components/materials/DocumentReader';
import { MaterialStatusBadge } from '@/components/materials/MaterialStatusBadge';
import { SourceLocator } from '@/components/materials/SourceLocator';
import {
  MATERIAL_SOURCE_TYPE_LABELS_ZH,
  type MaterialSourceType,
  type MaterialStatus,
} from '@/lib/constants';
import {
  getMaterialSource,
  getMaterialStatus,
  getReaderView,
  listChunkToc,
  MATERIAL_READER_MODES,
  type MaterialReaderMode,
} from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string; chunk?: string }>;
}

/** 只接受白名单里的模式；其它值一律回退到 `original`。 */
function resolveMode(raw: string | undefined): MaterialReaderMode {
  const found = MATERIAL_READER_MODES.find((mode) => mode === raw);
  return found ?? 'original';
}

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors';

export default async function MaterialReadPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const query = await searchParams;
  const mode = resolveMode(query.mode);

  const [view, toc, source, status] = await Promise.all([
    getReaderView(id, mode),
    listChunkToc(id),
    getMaterialSource(id),
    getMaterialStatus(id),
  ]);
  if (!status) notFound();

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <h1 className="truncate text-base font-semibold text-ink">
            {view?.title ?? status.title}
          </h1>
          <MaterialStatusBadge status={status.status as MaterialStatus} />
        </div>
        <p className="mt-0.5 text-[11px] text-inkMuted">
          原文视图 · 逐字呈现解析结果，不做改写或摘要
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={`/materials/${id}/analysis`}
          className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
        >
          审核 AI 分析
        </Link>
        <Link
          href={`/materials/${id}/processing`}
          className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
        >
          处理进度
        </Link>
        <Link
          href="/materials"
          className={`${LINK_CLASS} border-transparent text-inkMuted hover:bg-surfaceAlt hover:text-ink`}
        >
          返回材料库
        </Link>
      </div>
    </div>
  );

  // 没有当前解析版本：材料可能存在，但还没解析出正文（不是 404）
  if (!view) {
    return (
      <div className="space-y-3">
        {header}
        <div className="rounded-lg border border-dashed border-line bg-surface p-4 text-xs leading-relaxed text-inkMuted">
          这份材料还没有解析出可读的正文。
          <Link
            href={`/materials/${id}/processing`}
            className="ml-1 text-brand underline-offset-2 hover:underline"
          >
            去处理页看进度
          </Link>
        </div>
        <SourceLocator source={source} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {header}

      {source?.restrictedExport && (
        <p className="rounded-md border border-egYellow/50 bg-egYellow/10 p-2 text-[11px] leading-relaxed text-ink">
          受限来源（{MATERIAL_SOURCE_TYPE_LABELS_ZH[source.sourceType as MaterialSourceType] ?? '未知'}）：
          仅供个人学习使用，不能导出或分享。
        </p>
      )}

      <DocumentReader view={view} toc={toc} highlightChunkId={query.chunk} />

      <SourceLocator source={source} />
    </div>
  );
}
