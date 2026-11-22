/**
 * `/materials/[id]/analysis` AI 分析结果审核。
 *
 * 页面自己**不做任何判定**：
 * - 三条计数与闸门结论来自 `readMaterialReviewGate()`（与 action 里落库用的是同一个函数），
 *   避免"页面说可以 ready、点下去却被拒"这种自相矛盾；
 * - 结果列表来自 `listExtractionResults()`，`payloadJson` 解析失败退化成 `{}`，
 *   不会因为一条脏数据把整页打成 500。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BulkReviewBar } from '@/components/materials/BulkReviewBar';
import { MaterialStatusBadge } from '@/components/materials/MaterialStatusBadge';
import { SourceLocator } from '@/components/materials/SourceLocator';
import { MATERIAL_LIMITS, type MaterialStatus } from '@/lib/constants';
import { isProcessingStatus } from '@/lib/materials/stateMachine';
import {
  getMaterialAnalysisProgress,
  getMaterialSource,
  getMaterialStatus,
  listExtractionResults,
} from '@/lib/queries/materials';
import { readMaterialReviewGate } from '@/lib/services/materialReviewSettle';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors';

export default async function MaterialAnalysisPage({ params }: PageProps) {
  const { id } = await params;

  const [status, cards, source, gate, analysisProgress] = await Promise.all([
    getMaterialStatus(id),
    listExtractionResults(id),
    getMaterialSource(id),
    readMaterialReviewGate(id),
    getMaterialAnalysisProgress(id),
  ]);
  if (!status) notFound();

  const materialStatus = status.status as MaterialStatus;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h1 className="truncate text-base font-semibold text-ink">{status.title}</h1>
            <MaterialStatusBadge status={materialStatus} />
          </div>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            AI 分析审核 · 共 {cards.length} 条结果 · 每条都附原文依据
          </p>
          {/* 成本可见性：单次运行上限 60 次，累计值必须一直看得见 */}
          <p className="mt-0.5 text-[11px] text-inkMuted">
            本材料累计 AI 调用 {status.aiUsage.calls} 次 · 预估 $
            {status.aiUsage.estimatedCostUsd.toFixed(4)}
            {` · 单次运行上限 ${MATERIAL_LIMITS.maxAiCalls} 次`}
            {` · 已分析 ${analysisProgress.analyzedChunks}/${analysisProgress.totalChunks} 块`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/materials/${id}/read`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            读原文
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

      {status.statusReason && (
        <p className="rounded-md border border-line bg-surfaceAlt p-2 text-[11px] leading-relaxed text-ink">
          {status.statusReason}
        </p>
      )}

      {/* 分析还没结束（或已失败/取消）时不显示审核栏：
          此时闸门会说"全部已审核"，那只是"还没有结果"，会误导用户。 */}
      {isProcessingStatus(materialStatus) ? (
        <p className="rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed text-inkMuted">
          AI 分析还在进行中，结果会陆续出现在这里。
          <Link
            href={`/materials/${id}/processing`}
            className="ml-1 text-brand underline-offset-2 hover:underline"
          >
            去处理页看进度
          </Link>
        </p>
      ) : materialStatus === 'failed' || materialStatus === 'cancelled' ? (
        <p className="rounded-lg border border-egRed/40 bg-egRed/10 p-3 text-xs leading-relaxed text-ink">
          这次处理没有成功完成（{materialStatus === 'failed' ? '失败' : '已取消'}），
          因此没有可审核的分析结果。
          <Link
            href={`/materials/${id}/processing`}
            className="ml-1 text-brand underline-offset-2 hover:underline"
          >
            去处理页重试
          </Link>
        </p>
      ) : (
        <BulkReviewBar
          materialId={id}
          cards={cards}
          materialStatus={materialStatus}
          gate={gate}
          remainingChunks={analysisProgress.remainingChunks}
        />
      )}

      <SourceLocator source={source} />
    </div>
  );
}
