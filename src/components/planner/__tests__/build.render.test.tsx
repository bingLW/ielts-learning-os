import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DISCLAIMER_CEFR } from '@/lib/constants';
import { PlanBuilderBody } from '../build/PlanBuilderBody';
import { builderContext, draftDto } from './fixtures';
import type { DraftDto } from '@/lib/queries/planner';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

vi.mock('@/lib/actions/planner', () => ({
  generatePlanPreviewAction: vi.fn(),
  confirmPlanVersionAction: vi.fn(),
  saveDraftAction: vi.fn(),
}));

function render(context = builderContext(), horizonDays = 7, draft: DraftDto | null = null) {
  return renderToStaticMarkup(
    <PlanBuilderBody context={context} horizonDays={horizonDays} draft={draft} />,
  );
}

describe('T12 渲染：/planner/build', () => {
  it('① 未确认诊断 → 30/90 层禁用 + 7 天层提示「无诊断依据」', () => {
    const context = builderContext({ diagnosisReady: false, disabledLayers: ['MONTH', 'CYCLE'] });
    const html = render(context, 7);

    expect(html).toContain('无诊断依据');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('缺诊断');
    expect(html).not.toContain('/planner/build?horizon=30');
    expect(html).not.toContain('/planner/build?horizon=90');
    // 7 天层仍可用
    expect(html).toContain('/planner/build?horizon=7');
  });

  it('② 四层状态正确：未生成 / 已确认（已发布）/ 已过期 / 草稿', () => {
    const html = render(builderContext(), 7, draftDto());

    expect(html).toContain('未生成');
    expect(html).toContain('已发布');
    expect(html).toContain('已过期');
    expect(html).toContain('草稿');
    expect(html).toContain('snap-dra');
  });

  it('③ 30 天层读 layer=MONTH 版本的 afterSnapshot，渲染 8 项结构', () => {
    const context = builderContext({ horizonDays: 30, layer: 'MONTH' });
    const html = render(context, 30);

    for (let index = 1; index <= 8; index += 1) {
      expect(html).toContain(`data-structure-item="${index}"`);
    }
    for (const title of [
      '阶段目标',
      '周里程碑',
      '技能配比',
      '每周测试',
      '材料建议',
      '词汇语法范围',
      '验收指标',
      '调整条件',
    ]) {
      expect(html).toContain(title);
    }
    expect(html).toContain('B1 总分 6.0');
  });

  it('④ 过期版本 → stale 徽章 + 重新生成；不自动改写（无表单即无写请求）', () => {
    const html = render(builderContext({ horizonDays: 30, layer: 'MONTH' }), 30);

    expect(html).toContain('data-testid="stale-badge"');
    expect(html).toContain('计划已过期');
    expect(html).toContain('系统不会自动改写这一版');
    expect(html).toContain('重新生成');
    expect(html).not.toContain('<form');
  });

  it('⑤ 90 天层固定免责文案存在', () => {
    const context = builderContext({ horizonDays: 90, layer: 'CYCLE' });
    const html = render(context, 90);

    expect(html).toContain('data-testid="cycle-disclaimer"');
    expect(html).toContain('90 天周期是规划展望');
    expect(html).toContain('不承诺分数提升');
    expect(html).toContain(DISCLAIMER_CEFR);
  });
});