/**
 * 四层切换：7 / 30 / 90 / 1 天。
 *
 * 未确认诊断时 30/90 层**禁用而不是隐藏**：用户要能看到「这两层存在，但缺前置数据」，
 * 而不是以为产品没有这个能力。
 */

import Link from 'next/link';
import type { BuilderLayerStateDto } from '@/lib/queries/planner';
import type { PlanLayer } from '@/lib/services/planBuild';

const TAB: { horizon: number; layer: PlanLayer; label: string }[] = [
  { horizon: 7, layer: 'WEEK', label: '7 天' },
  { horizon: 30, layer: 'MONTH', label: '30 天' },
  { horizon: 90, layer: 'CYCLE', label: '90 天' },
  { horizon: 1, layer: 'DAY', label: '1 天' },
];

function statusOf(layer: BuilderLayerStateDto | undefined): string {
  if (!layer || !layer.versionId) return '未生成';
  if (layer.staleAt) return '已过期';
  return '已发布';
}

export function LayerSwitcher({
  activeHorizon,
  diagnosisReady,
  layers,
}: {
  activeHorizon: number;
  diagnosisReady: boolean;
  layers: BuilderLayerStateDto[];
}) {
  return (
    <nav aria-label="计划层级" className="flex flex-wrap gap-1.5">
      {TAB.map((tab) => {
        const state = layers.find((row) => row.layer === tab.layer);
        const disabled = !diagnosisReady && (tab.layer === 'MONTH' || tab.layer === 'CYCLE');
        const active = tab.horizon === activeHorizon;
        const body = (
          <>
            <span className="font-medium">{tab.label}</span>
            <span className="ml-1 text-[10px] text-inkMuted">{statusOf(state)}</span>
          </>
        );
        return disabled ? (
          <span
            key={tab.horizon}
            aria-disabled="true"
            title="需要先确认一轮诊断结果（至少 1 条证据或一份能力画像）"
            className="cursor-not-allowed rounded-md border border-dashed border-line px-2.5 py-1 text-xs text-inkMuted opacity-60"
          >
            {body}
            <span className="ml-1 text-[10px]">缺诊断</span>
          </span>
        ) : (
          <Link
            key={tab.horizon}
            href={`/planner/build?horizon=${tab.horizon}`}
            aria-current={active ? 'page' : undefined}
            className={[
              'rounded-md border px-2.5 py-1 text-xs',
              active ? 'border-brand bg-blue-50 text-brand' : 'border-line text-ink hover:bg-surfaceAlt',
            ].join(' ')}
          >
            {body}
          </Link>
        );
      })}
    </nav>
  );
}