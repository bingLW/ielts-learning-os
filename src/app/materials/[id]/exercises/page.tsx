/**
 * `/materials/[id]/exercises` 练习生成与审核。
 *
 * 页面自己**不做任何判定**：
 * - 「能不能生成」来自 `getMaterialExerciseReadiness()`（与 action 的前置断言同一口径）；
 * - 「该是什么状态」由服务端 action 写库后由 `settleMaterialReviewStatus` 结算；
 * - 题目列表来自 `getExerciseSet(..., { revealAnswers: true })` —— 审核页必须能看到
 *   正确答案与解析，否则人没法判断这道题对不对。作答页则相反（见 `/exercises/[setId]`）。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExerciseBuilderBody } from '@/components/materials/ExerciseBuilderBody';
import { MaterialStatusBadge } from '@/components/materials/MaterialStatusBadge';
import { MATERIAL_LIMITS, type MaterialStatus } from '@/lib/constants';
import {
  getExerciseSet,
  getMaterialExerciseReadiness,
  getMaterialStatus,
  listExerciseSets,
} from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors';

export default async function MaterialExercisesPage({ params }: PageProps) {
  const { id } = await params;

  const [status, sets, readiness] = await Promise.all([
    getMaterialStatus(id),
    listExerciseSets(id),
    getMaterialExerciseReadiness(id),
  ]);
  if (!status) notFound();

  // 活动集优先；没有活动集时退回最近一个（历史集也能看，只是不再追加题目）
  const target = sets.find((set) => set.isActive) ?? sets[0] ?? null;
  const detail = target ? await getExerciseSet(target.id, { revealAnswers: true }) : null;

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
            练习题审核 · 一材料一练习集 · 单材料上限 {MATERIAL_LIMITS.maxExercises} 道
          </p>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            本材料累计 AI 调用 {status.aiUsage.calls} 次 · 预估 $
            {status.aiUsage.estimatedCostUsd.toFixed(4)}
            {` · 出题依据 ${readiness.acceptedAnchors} 条已采纳结果`}
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

      <ExerciseBuilderBody
        materialId={id}
        materialStatus={materialStatus}
        readiness={readiness}
        sets={sets}
        activeSet={detail}
      />
    </div>
  );
}
