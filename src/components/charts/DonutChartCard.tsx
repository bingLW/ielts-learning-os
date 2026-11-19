'use client';

/**
 * 环形图卡片（T30）：用于「EGIU 三色分布」这类构成比。
 *
 * 无障碍：环形图只是「补充视觉」，同一份数据必须在旁边有文字计数
 * （色盲用户依赖文字 + 图标，不能只靠扇区颜色）。
 */

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { SeriesPointDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { ChartFrame } from './ChartFrame';

export interface DonutChartCardProps {
  title: string;
  description?: string;
  points: SeriesPointDto[];
  colors: string[];
  emptyHint?: string;
  height?: number;
  /** 中心文案（例如总数）。 */
  centerLabel?: string;
}

export function DonutChartCard({
  title,
  description,
  points,
  colors,
  emptyHint,
  height = 180,
  centerLabel,
}: DonutChartCardProps) {
  const total = points.reduce((sum, point) => sum + (point.value ?? 0), 0);
  const isEmpty = total <= 0;

  return (
    <Card title={title} description={description}>
      {isEmpty ? (
        <p className="py-8 text-center text-xs text-inkMuted">
          {emptyHint ?? '暂无数据：先完成一次判定或记录才会出现构成比'}
        </p>
      ) : (
        <div className="space-y-2">
          <ChartFrame height={height} ariaLabel={title}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={points}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="55%"
                  outerRadius="82%"
                  paddingAngle={1}
                  isAnimationActive={false}
                >
                  {points.map((point, index) => (
                    <Cell key={point.label} fill={colors[index % colors.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: 'var(--color-line)' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </ChartFrame>

          {centerLabel && <p className="text-center text-[11px] text-inkMuted">{centerLabel}</p>}

          <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            {points.map((point, index) => (
              <li key={point.label} className="flex items-center gap-1 text-[11px] text-inkMuted">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: colors[index % colors.length] }}
                />
                {point.label}
                <b className="tabular text-ink">{point.value ?? 0}</b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
