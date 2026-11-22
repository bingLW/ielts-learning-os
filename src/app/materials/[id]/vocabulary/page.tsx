/**
 * `/materials/[id]/vocabulary` 词汇候选审核 + 主库同步。
 *
 * 页面自己**不做任何判定**：
 * - 「这条能不能同步」由 `domain/materialVocabSync.decideSync` 决定（纯函数，单测覆盖）；
 * - 「材料该不该 ready」由 `services/materialReviewSettle` 落库；
 * - 汇总数字来自 `getMaterialVocabSummary()`（与列表同一口径的现查结果）。
 *
 * 为什么把「补建候选」按钮放在这里：T12 之前审核过的材料没有任何候选，
 * 用户没有别的入口能让词汇辅助模式活过来。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MaterialStatusBadge } from '@/components/materials/MaterialStatusBadge';
import { VocabCandidateTable } from '@/components/materials/VocabCandidateTable';
import { MATERIAL_LIMITS, type MaterialStatus } from '@/lib/constants';
import {
  countNormalizationDrift,
  getMaterialStatus,
  getMaterialVocabSummary,
  listVocabularyCandidates,
  VOCAB_CANDIDATE_FILTERS,
  type VocabCandidateFilter,
} from '@/lib/queries/materials';
import { readMaterialReviewGate } from '@/lib/services/materialReviewSettle';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors';

/** `?status=` 的容错：非法值按 `all` 处理（不改 404，筛选器坏了不该挡住审核）。 */
function parseFilter(raw: string | undefined): VocabCandidateFilter {
  return (VOCAB_CANDIDATE_FILTERS as readonly string[]).includes(raw ?? '')
    ? (raw as VocabCandidateFilter)
    : 'all';
}

export default async function MaterialVocabularyPage({ params, searchParams }: PageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const filter = parseFilter(query.status);

  const [status, summary, candidates, gate, driftCount] = await Promise.all([
    getMaterialStatus(id),
    getMaterialVocabSummary(id),
    listVocabularyCandidates(id, filter),
    readMaterialReviewGate(id),
    countNormalizationDrift(),
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
            词汇候选 · 候选与主库物理分离 · 只有人确认过的词才会进词库
          </p>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            本材料累计 AI 调用 {status.aiUsage.calls} 次 · 预估 $
            {status.aiUsage.estimatedCostUsd.toFixed(4)}
            {` · 单次运行上限 ${MATERIAL_LIMITS.maxAiCalls} 次`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/materials/${id}/analysis`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            AI 分析审核
          </Link>
          <Link
            href={`/materials/${id}/read?mode=vocab_assist`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            词汇辅助阅读
          </Link>
          <Link
            href={`/materials/${id}/exercises`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            练习题
          </Link>
          <Link
            href="/materials"
            className={`${LINK_CLASS} border-transparent text-inkMuted hover:bg-surfaceAlt hover:text-ink`}
          >
            返回材料库
          </Link>
        </div>
      </div>

      {/* 闸门结论：候选没审完 → 材料不会变 ready，这里说清楚原因 */}
      {materialStatus === 'review_required' && gate.pendingTotal > 0 && (
        <p className="rounded-md border border-egYellow/60 bg-egYellow/10 p-2 text-[11px] leading-relaxed text-ink">
          {gate.reasonZh}。其中词汇候选 {summary.draft} 条 —— 审完（或跳过）之后材料才会进入可用状态。
        </p>
      )}

      {status.statusReason && (
        <p className="rounded-md border border-line bg-surfaceAlt p-2 text-[11px] leading-relaxed text-ink">
          {status.statusReason}
        </p>
      )}

      {/*
        历史归一化键提示（只提示，不修复）。
        T12 改过 normalizeLemma，旧词条的键停在旧空间里。同步时会按原词形兜底匹配，
        所以**不会**重复建词条 —— 但用户有权知道库里不是完全干净的。
      */}
      {driftCount > 0 && (
        <p className="rounded-md border border-egYellow/60 bg-egYellow/10 p-2 text-[11px] leading-relaxed text-ink">
          库里有 {driftCount} 条词条的归一化键是旧版本（旧版算法算的）。同步时会按原词形匹配到它们，
          <span className="font-medium">不会重复创建</span>；这里只提示，不会自动改写主库数据。
        </p>
      )}

      <VocabCandidateTable
        materialId={id}
        materialStatus={materialStatus}
        summary={summary}
        candidates={candidates}
        filter={filter}
      />
    </div>
  );
}
