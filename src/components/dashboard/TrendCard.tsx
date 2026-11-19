/**
 * Dashboard ⑧ 趋势：7 天 / 30 天净时长。
 *
 * 本轮图表容器按架构约定先留占位（阶段 D 用 Recharts 实现），
 * 但**数据是真的**：空缺日 `minutes = null`，渲染成断点而不是补 0 的折线，
 * 并同时提供数据表替代（无障碍 + 可下钻核对）。
 */

import { formatDurationZh } from '@/lib/format';
import type { TrendPointDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';

function TrendTable({ points, label }: { points: TrendPointDto[]; label: string }) {
  const valid = points.filter((point) => point.minutes !== null);
  const max = valid.reduce((peak, point) => Math.max(peak, point.minutes ?? 0), 0);

  if (valid.length < 2) {
    return (
      <p className="rounded border border-dashed border-line px-2 py-3 text-center text-[11px] text-inkMuted">
        {label}：数据不足，需 ≥2 天有效记录（当前 {valid.length} 天）。空缺日不会被补 0。
      </p>
    );
  }

  return (
    <div>
      <div
        className="flex h-16 items-end gap-0.5"
        role="img"
        aria-label={`${label} 净学习时长柱状占位，最高 ${max} 分钟`}
      >
        {points.map((point) => {
          const height =
            point.minutes === null || max === 0 ? 0 : Math.max(2, Math.round((point.minutes / max) * 64));
          return (
            <div key={point.date} className="flex flex-1 flex-col items-center justify-end gap-0.5">
              {point.minutes === null ? (
                <span
                  className="w-full border-t border-dashed border-line"
                  style={{ height: 1 }}
                  title={`${point.date} 无记录（断点）`}
                />
              ) : (
                <span
                  className="w-full rounded-t bg-brand"
                  style={{ height }}
                  title={`${point.date}：${point.minutes} 分钟`}
                />
              )}
            </div>
          );
        })}
      </div>

      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-inkMuted">
          数据表替代（{label}，共 {points.length} 天，有效 {valid.length} 天）
        </summary>
        <table className="mt-1 w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-line text-left text-inkMuted">
              <th className="py-0.5 font-medium">日期</th>
              <th className="py-0.5 text-right font-medium">净时长</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date} className="border-b border-line">
                <td className="tabular py-0.5">{point.date}</td>
                <td className="tabular py-0.5 text-right">
                  {point.minutes === null ? '无记录' : formatDurationZh(point.minutes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function TrendCard({
  trend7,
  trend30,
}: {
  trend7: TrendPointDto[];
  trend30: TrendPointDto[];
}) {
  return (
    <Card
      title="净时长趋势"
      description="空缺日显示为空断点，不补 0 —— 折线/柱状图在阶段 D 用图表库替换，数据源不变。"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TrendTable points={trend7} label="近 7 天" />
        <TrendTable points={trend30} label="近 30 天" />
      </div>
    </Card>
  );
}
