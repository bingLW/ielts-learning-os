import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilterBar } from '@/components/analytics/FilterBar';

describe('FilterBar 服务端渲染', () => {
  it('使用页面传入的业务日，不调用客户端 Hook', () => {
    const html = renderToStaticMarkup(
      <FilterBar
        filter={{ from: '2026-11-01', to: '2026-11-27', stageId: null, skill: null, resourceId: null }}
        options={{ stages: [], skills: [], resources: [] }}
        businessDate="2026-11-27"
      />,
    );

    expect(html).toContain('name="tab" value="analytics"');
    expect(html).toContain('/weekly?tab=analytics&amp;from=2026-10-29&amp;to=2026-11-27');
    expect(html).toContain('value="2026-11-27"');
  });
});
