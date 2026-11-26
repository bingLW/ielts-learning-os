import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CHART_MIN_POINTS } from '@/lib/constants';
import { LineChartCard } from '@/components/charts/LineChartCard';

describe('LineChartCard 数据不足提示', () => {
  it('只有一个有效点时提示点数不足，不误报为没有数据', () => {
    const html = renderToStaticMarkup(
      <LineChartCard
        title="每日净学习时长"
        points={[
          { label: '11-26', value: null },
          { label: '11-27', value: 5 },
        ]}
      />,
    );

    expect(html).toContain(`至少需要 ${CHART_MIN_POINTS} 个有效数据点才会画出趋势线`);
    expect(html).not.toContain('没有计时数据');
  });
});
