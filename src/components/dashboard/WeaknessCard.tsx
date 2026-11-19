/**
 * Dashboard ⑨ 薄弱点 Top3。
 *
 * 依据三元组必显（名称 + 「错 X/Y 题 · 主要类别 · 趋势」+ 行动建议），
 * 样本不足的维度单列「数据不足」，不参与排序。
 */

import type { WeaknessDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';

export function WeaknessCard({
  ranked,
  insufficient,
  dataDays,
}: {
  ranked: WeaknessDto[];
  insufficient: WeaknessDto[];
  dataDays: number;
}) {
  return (
    <Card
      title="薄弱点 Top3"
      description="口径：0.35×错题率 + 0.25×正确率缺口 + 0.15×投入缺口 + 0.15×复习债 + 0.10×红灯密度（近 28 天）"
    >
      {dataDays < 2 ? (
        <p className="rounded border border-dashed border-line px-2 py-3 text-center text-[11px] text-inkMuted">
          数据不足，需 ≥2 天有效记录才能排序（避免用一天的数据下结论）。
        </p>
      ) : ranked.length === 0 ? (
        <p className="rounded border border-dashed border-line px-2 py-3 text-center text-[11px] text-inkMuted">
          还没有达到样本阈值（单维度 ≥10 题）的薄弱项，暂不排序。
        </p>
      ) : (
        <ol className="space-y-1.5">
          {ranked.map((item, index) => (
            <li key={item.name} className="rounded border border-line bg-surfaceAlt px-2 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-ink">
                  {index + 1}. {item.name}
                </span>
                <span className="tabular text-[11px] text-inkMuted">评分 {item.score}</span>
              </div>
              <p className="text-[11px] text-inkMuted">依据：{item.evidence}</p>
              <p className="text-[11px] text-brand">建议：{item.actionHint}</p>
            </li>
          ))}
        </ol>
      )}

      {insufficient.length > 0 && (
        <div className="mt-2 rounded border border-dashed border-line px-2 py-1">
          <p className="text-[11px] font-medium text-inkMuted">数据不足，暂不排序</p>
          <ul className="mt-0.5 flex flex-wrap gap-1">
            {insufficient.slice(0, 6).map((item) => (
              <li
                key={item.name}
                className="rounded bg-white px-1.5 py-0.5 text-[10px] text-inkMuted"
                title={item.evidence}
              >
                {item.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
