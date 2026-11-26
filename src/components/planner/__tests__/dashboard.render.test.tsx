import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DashboardBody } from '../dashboard/DashboardBody';
import { dashboardDto } from './fixtures';

function render(overrides = dashboardDto()) {
  return renderToStaticMarkup(<DashboardBody data={overrides} />);
}

describe('T11 渲染：/planner 仪表盘', () => {
  it('① 未诊断 → 只有「先做一轮诊断」单卡，其余区块全部不渲染', () => {
    const html = render(dashboardDto({ diagnosed: false, latestSnapshotId: null }));
    expect(html).toContain('先做一轮诊断');
    expect(html).toContain('href="/diagnostics"');
    expect(html).toContain('data-block="no-diagnosis"');
    for (const block of ['status', 'today', 'pending', 'gaps', 'uncertainty', 'banners']) {
      expect(html).not.toContain(`data-block="${block}"`);
    }
  });

  it('② 有诊断 → 六个区块全部渲染', () => {
    const html = render();
    for (const block of ['status', 'today', 'pending', 'gaps', 'uncertainty', 'banners']) {
      expect(html).toContain(`data-block="${block}"`);
    }
    for (const title of ['状态带', '今日决策', '待你确认', '计划缺口（四技能）', '缺口与不确定度', '提示与护栏']) {
      expect(html).toContain(title);
    }
  });

  it('③ AI 关闭 → 状态带出现灰色「AI 未参与」徽章；失败 → 明示已回落规则', () => {
    const off = render(dashboardDto({ statusBand: { ...dashboardDto().statusBand, aiMode: 'off' } }));
    expect(off).toContain('AI 未参与');
    expect(off).toContain('title="aiMode=off"');

    const failed = render(dashboardDto({ statusBand: { ...dashboardDto().statusBand, aiMode: 'failed' } }));
    expect(failed).toContain('已回落规则');
  });
});