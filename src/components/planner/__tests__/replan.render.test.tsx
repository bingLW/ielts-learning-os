import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DiffTable } from '../replan/DiffTable';
import { ProtectedNotice } from '../replan/ProtectedNotice';
import { ReplanPreviewBody } from '../replan/ReplanPreviewBody';
import { noChangeDiff, replanContext, replanDiff } from './fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

vi.mock('@/lib/actions/planner', () => ({
  previewReplanAction: vi.fn(),
  confirmReplanAction: vi.fn(),
}));

describe('T12 渲染：/planner/replan', () => {
  it('⑩ 三列对比 + 五种行标记', () => {
    const html = renderToStaticMarkup(<DiffTable entries={replanDiff().entries} />);

    expect(html).toContain('标记');
    expect(html).toContain('重排前');
    expect(html).toContain('重排后');
    for (const kind of ['ADD', 'REMOVE', 'MOVE', 'RESIZE', 'PRIORITY_CHANGE', 'KEEP']) {
      expect(html).toContain(`data-kind="${kind}"`);
    }
    for (const label of ['新增', '移除', '改期', '调整时长', '调优先级', '保持不变']) {
      expect(html).toContain(label);
    }
  });

  it('⑪ 受保护任务标「不会被改写」', () => {
    const notice = renderToStaticMarkup(<ProtectedNotice tasks={replanContext().tasks} />);
    expect(notice).toContain('不会被改写');
    expect(notice).toContain('受保护任务（1 条）');

    const table = renderToStaticMarkup(<DiffTable entries={replanDiff().entries} />);
    expect(table).toContain('不会被改写');
  });

  it('⑫ hasChanges=false → 主按钮禁用', () => {
    const html = renderToStaticMarkup(
      <ReplanPreviewBody context={replanContext()} initialPreview={{ diff: noChangeDiff(), previewToken: 'tok-1', snapshotId: 'snap-r' }} />,
    );

    expect(html).toContain('data-testid="replan-confirm"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('本次没有可确认的变更');
  });

  it('hasChanges=true → 主按钮可用', () => {
    const html = renderToStaticMarkup(
      <ReplanPreviewBody context={replanContext()} initialPreview={{ diff: replanDiff(), previewToken: 'tok-1', snapshotId: 'snap-r' }} />,
    );
    expect(html).toContain('data-testid="replan-confirm"');
    expect(html).not.toContain('本次没有可确认的变更');
  });
});