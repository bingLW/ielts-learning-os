/**
 * `/materials/[id]` 材料详情 = 学习包总览（T13）。
 *
 * 页面自己**不做判定**：
 * - 能不能建包/排草案由 action 的前置断言决定（这里只按状态禁用按钮，同一口径）；
 * - 叠加的时长、技能、条目顺序全部来自 `getMaterialPack()`（引用式聚合的解析结果）；
 * - 草案的逐日超支明细来自 `getTaskProposal()`（与确认前的校验同一个纯函数）。
 *
 * 三块的顺序是「看 → 排 → 删」：先看清这份材料学什么，再决定怎么排进日程，
 * 最后才是危险操作。删除放在最下面且需要手输确认，不会误触。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DangerZone } from '@/components/materials/DangerZone';
import { MaterialStatusBadge } from '@/components/materials/MaterialStatusBadge';
import { PackOverviewBody } from '@/components/materials/PackOverviewBody';
import { TaskProposalPanel } from '@/components/materials/TaskProposalPanel';
import { MATERIAL_LIMITS, type MaterialStatus } from '@/lib/constants';
import { today } from '@/lib/date';
import {
  getDeletionPreview,
  getMaterialPack,
  getMaterialStatus,
  getTaskProposal,
} from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors';

/** 允许建包/排草案的状态（与 `actions/materialPack` 的 `PACKABLE_STATUSES` 同口径）。 */
const PACKABLE: readonly MaterialStatus[] = ['ready', 'partial', 'review_required'];

export default async function MaterialDetailPage({ params }: PageProps) {
  const { id } = await params;

  const [status, pack, proposal, preview] = await Promise.all([
    getMaterialStatus(id),
    getMaterialPack(id),
    getTaskProposal(id),
    getDeletionPreview(id),
  ]);
  if (!status || !pack || !preview) notFound();

  const materialStatus = status.status as MaterialStatus;
  const canBuild = PACKABLE.includes(materialStatus);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h1 className="truncate text-base font-semibold text-ink">{status.title}</h1>
            <MaterialStatusBadge status={materialStatus} />
          </div>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            材料详情 · 学习包只聚合引用，不复制正文
          </p>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            本材料累计 AI 调用 {status.aiUsage.calls} 次 · 预估 $
            {status.aiUsage.estimatedCostUsd.toFixed(4)}
            {` · 单次运行上限 ${MATERIAL_LIMITS.maxAiCalls} 次`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/materials/${id}/read`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            阅读原文
          </Link>
          <Link
            href={`/materials/${id}/analysis`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            AI 分析审核
          </Link>
          <Link
            href={`/materials/${id}/exercises`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            练习题
          </Link>
          <Link
            href={`/materials/${id}/vocabulary`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            词汇候选
          </Link>
          <Link
            href={`/materials/${id}/source`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            来源与权限
          </Link>
          <Link
            href="/materials"
            className={`${LINK_CLASS} border-transparent text-inkMuted hover:bg-surfaceAlt hover:text-ink`}
          >
            返回材料库
          </Link>
        </div>
      </div>

      {materialStatus === 'review_required' && (
        <p className="rounded-md border border-egYellow/60 bg-egYellow/10 p-2 text-[11px] leading-relaxed text-ink">
          这份材料还有 AI 结果没审完。现在生成的包/草案是<strong>半成品</strong>：审完之后建议重建一次。
        </p>
      )}

      {status.statusReason && (
        <p className="rounded-md border border-line bg-surfaceAlt p-2 text-[11px] leading-relaxed text-ink">
          {status.statusReason}
        </p>
      )}

      <PackOverviewBody
        materialId={id}
        pack={pack}
        provisional={materialStatus === 'review_required'}
        canBuild={canBuild}
      />

      <TaskProposalPanel
        materialId={id}
        proposal={proposal}
        canCreate={canBuild && pack.packId !== null}
        baseDate={today()}
      />

      <DangerZone preview={preview} />
    </div>
  );
}
