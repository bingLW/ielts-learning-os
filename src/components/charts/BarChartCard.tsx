'use client';

/**
 * 柱图卡片（T30）：用于「每周时长」「错题类型」「科目记录历史」等离散比较。
 *
 * 支持横向条形（`horizontal`），移动端窄屏时横向条形更容易读标签。
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_MIN_POINTS } from '@/lib/constants';
import type { SeriesPointDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { ChartFrame } from './ChartFrame';

export interface BarChartCardProps {
  title: string;
  description?: string;
  points: SeriesPointDto[];
  color?: string;
  emptyHint?: string;
  height?: number;
  /** 横向条形：长标签更好读。 */
  horizontal?: boolean;
}

export function BarChartCard({
  title,
  description,
  points,
  color = 'var(--color-brand)',
  emptyHint,
  height = 200,
  horizontal = false,
}: BarChartCardProps) {
  const validCount = points.filter((point) => point.value !== null).length;
  const isEmpty = validCount < CHART_MIN_POINTS;

  return (
    <Card title={title} description={description}>
      {isEmpty ? (
        <p className="py-8 text-center text-xs text-inkMuted">
          {emptyHint ?? `至少需要 ${CHART_MIN_POINTS} 个有数据的分组才会出图`}
        </p>
      ) : (
        <ChartFrame height={height} ariaLabel={title}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={points}
              layout={horizontal ? 'vertical' : 'horizontal'}
              margin={{ top: 8, right: 12, bottom: 0, left: horizontal ? 12 : 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
              {horizontal ? (
                <>
                  <XAxis
                    type="number"
                    tick={{ fontSize: 10, fill: 'var(--color-ink-muted)' }}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={72}
                    tick={{ fontSize: 10, fill: 'var(--color-ink-muted)' }}
                  />
                </>
              ) : (
                <>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'var(--color-ink-muted)' }}
                    interval={0}
                    angle={points.length > 6 ? -30 : 0}
                    textAnchor={points.length > 6 ? 'end' : 'middle'}
                    height={points.length > 6 ? 44 : 24}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--color-ink-muted)' }}
                    width={36}
                  />
                </>
              )}
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: 'var(--color-line)' }}
              />
              <Bar dataKey="value" fill={color} radius={3} isAnimationActive={false} name={title} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
    </Card>
  );
}
