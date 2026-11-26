import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GapSummaryBody } from '../evidence/GapSummaryBody';
import { gapSummaryDto } from './fixtures';

function render(overrides: { skill?: 'LISTENING' | 'READING' | 'SPEAKING' | 'WRITING'; summary?: ReturnType<typeof gapSummaryDto> } = {}) {
  return renderToStaticMarkup(
    <GapSummaryBody
      summary={overrides.summary ?? gapSummaryDto()}
      activeSkill={overrides.skill ?? 'READING'}
      evidenceId={null}
      evidence={null}
    />,
  );
}

describe('T11 渲染：/planner/evidence', () => {
  it('④ 四技能 Tab 各自独立：只渲染当前 Tab 的缺口，Tab 是可分享链接', () => {
    const html = render({ skill: 'READING' });
    for (const skill of ['LISTENING', 'READING', 'SPEAKING', 'WRITING']) {
      expect(html).toContain(`href="/planner/evidence?snapshot=snap-1&amp;skill=${skill}"`);
    }
    expect(html).toContain('data-skill="READING"');
    expect(html).toContain('细节题定位偏差');
    expect(html).not.toContain('段落衔接弱');
    expect(html).toContain('aria-selected="true"');
  });

  it('⑤ 辅助维度只出现在折叠区内，并标注不计入四技能配比', () => {
    const html = render();
    const detailsStart = html.indexOf('<details');
    const detailsEnd = html.indexOf('</details>');
    expect(detailsStart).toBeGreaterThan(-1);
    expect(html.slice(detailsStart, detailsEnd)).toContain('辅助维度，不计入四技能配比');
    // 辅助维度的行必须在折叠区内部，不能出现在主列表
    expect(html.slice(0, detailsStart)).not.toContain('tense');
  });

  it('⑥ 无基线技能 → 「系统不假定 0 分」+ 一键排基线', () => {
    const html = render({ skill: 'LISTENING' });
    expect(html).toContain('系统不假定 0 分');
    expect(html).toContain('一键排基线任务');
    expect(html).toContain('sourceKind=PROBE');
    expect(html).not.toContain('已证实缺口（0）');
  });
});