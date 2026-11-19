'use client';

/**
 * 折线图卡片（T30）：用于「每日时长」「语法正确率趋势」「词汇积累」等连续序列。
 *
 * `value === null` 的点会被断开（`connectNulls={false}`），**不补 0** ——
 * 补 0 会把「没安排」画成「学了个 0 分钟」，属于口径造假。
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_MIN_POINTS } from '@/lib/constants';
import type { SeriesPointDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { ChartFrame } from './ChartFrame';

export interface LineChartCardProps {
  title: string;
  description?: string;
  points: SeriesPointDto[];
  color?: string;
  emptyHint?: string;
  height?: number;
}

export function LineChartCard({
  title,
  description,
  points,
  color = 'var(--color-brand)',
  emptyHint,
  height = 200,
}: LineChartCardProps) {
  const validCount = points.filter((point) => point.value !== null).length;
  const isEmpty = validCount < CHART_MIN_POINTS;

  return (
    <Card title={title} description={description}>
      {isEmpty ? (
        <p className="py-8 text-center text-xs text-inkMuted">
          {emptyHint ?? `至少需要 ${CHART_MIN_POINTS} 个有效数据点才会画出趋势线`}
        </p>
      ) : (
        <ChartFrame height={height} ariaLabel={title}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: 'var(--color-ink-muted)' }}
                interval="preserveStartEnd"
                minTickGap={12}
              />
              <YAxis tick={{ fontSize: 10, fill: 'var(--color-ink-muted)' }} width={36} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: 'var(--color-line)' }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
                name={title}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
    </Card>
  );
}
