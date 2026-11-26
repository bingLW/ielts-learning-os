import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VersionTimeline } from '../history/VersionTimeline';
import { VersionDiffView } from '../history/VersionDiffView';
import type {
  SnapshotProvenanceDto,
  VersionDiffDto,
  VersionHistoryRowDto,
} from '@/lib/queries/planner';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

vi.mock('@/lib/actions/planner', () => ({
  restorePlanVersionAction: vi.fn(),
}));

function row(overrides: Partial<VersionHistoryRowDto> = {}): VersionHistoryRowDto {
  return {
    id: 'ver-2',
    planDate: '2026-11-23',
    version: 2,
    layer: 'WEEK',
    changeSource: 'REPLAN',
    reason: '预算下调后重排',
    budgetMinutes: 180,
    snapshotId: 'snap-1',
    parentVersionId: null,
    staleAt: null,
    staleReason: null,
    createdAt: '2026-11-23T09:30:00.000Z',
    aiInvolved: false,
    ...overrides,
  };
}

const SNAPSHOT: SnapshotProvenanceDto = {
  id: 'snap-1',
  asOfDate: '2026-11-23',
  purpose: 'REPLAN',
  ruleVersion: 'v2.7.0',
  createdAt: '2026-11-23T09:00:00.000Z',
};

const DIFF: VersionDiffDto = {
  before: row({ id: 'ver-1', version: 1, reason: '候选任务确认写入计划' }),
  after: row(),
  rows: [
    {
      module: 'READING',
      moduleLabel: '阅读',
      beforeMinutes: 60,
      afterMinutes: 90,
      beforeCount: 2,
      afterCount: 3,
      deltaMinutes: 30,
    },
    {
      module: 'VOCABULARY',
      moduleLabel: '词汇',
      beforeMinutes: 30,
      afterMinutes: 30,
      beforeCount: 1,
      afterCount: 1,
      deltaMinutes: 0,
    },
  ],
};

describe('T13 渲染：/planner/history', () => {
  it('⑪ 时间线含版本号 / 来源 / 原因 / 预算 / AI 参与', () => {
    const html = renderToStaticMarkup(
      <VersionTimeline
        rows={[row()]}
        snapshots={{ 'snap-1': SNAPSHOT }}
        beforeId={null}
        afterId={null}
        linkFor={(id, role) => `/planner/history?${role}=${id}`}
      />,
    );
    expect(html).toContain('data-testid="version-timeline"');
    expect(html).toContain('data-version="2"');
    expect(html).toContain('v2 · 周计划');
    expect(html).toContain('来源：');
    expect(html).toContain('重排');
    expect(html).toContain('原因：');
    expect(html).toContain('预算下调后重排');
    expect(html).toContain('预算：');
    expect(html).toContain('180 分钟');
    expect(html).toContain('AI 参与：');
    expect(html).toContain('否（规则生成）');
    expect(html).toContain('已记录（2026-11-23 · v2.7.0）');
  });

  it('⑫ 差异视图三栏：模块 / 变更前 / 变更后', () => {
    const html = renderToStaticMarkup(<VersionDiffView diff={DIFF} />);
    expect(html).toContain('data-testid="version-diff"');
    expect(html).toContain('>模块<');
    expect(html).toContain('变更前');
    expect(html).toContain('变更后');
    expect(html).toContain('data-module="READING"');
    expect(html).toContain('data-before="60"');
    expect(html).toContain('data-after="90"');
    expect(html).toContain('阅读');
    expect(html).toContain('合计');
  });

  it('⑭ 快照被清理 → 标「快照已清理」+ 禁用恢复', () => {
    const html = renderToStaticMarkup(
      <VersionTimeline
        rows={[row({ snapshotId: 'snap-gone' })]}
        snapshots={{}}
        beforeId={null}
        afterId={null}
        linkFor={(id, role) => `/planner/history?${role}=${id}`}
      />,
    );
    expect(html).toContain('快照已清理');
    expect(html).toContain('data-testid="snapshot-cleaned"');
    expect(html).toContain('data-testid="restore-disabled"');
    expect(html).toContain('快照已清理，禁止恢复');
  });

  it('快照存在 → 恢复入口可用，且文案声明新增版本而非改写', () => {
    const html = renderToStaticMarkup(
      <VersionTimeline
        rows={[row()]}
        snapshots={{ 'snap-1': SNAPSHOT }}
        beforeId={null}
        afterId={null}
        linkFor={(id, role) => `/planner/history?${role}=${id}`}
      />,
    );
    expect(html).not.toContain('data-testid="restore-disabled"');
    expect(html).toContain('恢复为新版本');
  });

  it('MONTH/CYCLE 版本不提供恢复入口', () => {
    const html = renderToStaticMarkup(
      <VersionTimeline
        rows={[row({ layer: 'MONTH', snapshotId: null })]}
        snapshots={{}}
        beforeId={null}
        afterId={null}
        linkFor={(id, role) => `/planner/history?${role}=${id}`}
      />,
    );
    expect(html).toContain('data-testid="restore-disabled"');
    expect(html).toContain('MONTH / CYCLE 层版本本期不支持恢复');
  });
});