import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExplanationBody } from '../explain/ExplanationBody';
import { explanationDto } from './fixtures';
import type { EvidenceDetailDto } from '@/lib/types';

const EVIDENCE: EvidenceDetailDto = {
  id: 'ev-1',
  skill: 'READING',
  evidenceType: 'BASELINE',
  level: 'QUICK',
  parentEvidenceId: null,
  chainRootId: 'ev-1',
  outputPreview: '细节题 8 题正确 5 题',
  score: 62,
  scoreReason: '细节定位偏差',
  evidenceAnchor: null,
  assistanceLevel: 'A0',
  independent: true,
  assessorType: 'SELF',
  confidence: 'MEDIUM',
  hasArtifact: false,
  childCount: 0,
  archivedAt: null,
  createdAt: '2026-11-20T10:00:00.000Z',
  condition: null,
  dimensions: null,
  outputText: '细节题 8 题正确 5 题',
  privacyLevel: 'PRIVATE',
  note: null,
  artifact: null,
  parent: null,
  children: [],
};

describe('T12 渲染：/planner/explain/[versionId]', () => {
  it('⑥ 每条任务卡 8 个要素齐全（原因/目标/缺口引用/预计分钟/优先级/前置/产出/不做的影响）', () => {
    const html = renderToStaticMarkup(
      <ExplanationBody data={explanationDto()} evidenceId={null} evidence={null} />,
    );

    const fields = ['原因', '目标', '缺口引用', '预计分钟', '优先级', '前置条件', '产出', '不做的影响'];
    fields.forEach((label, index) => {
      expect(html).toContain(`data-explain-field="${index + 1}"`);
      expect(html).toContain(`${index + 1}. ${label}`);
    });
    expect(html).toContain('B1 总分 6.0');
    expect(html).toContain('OFFICIAL:READING:detail_scanning');
  });

  it('⑦ consequenceIfSkipped=null → 显示「无法判断」，不推测', () => {
    const html = renderToStaticMarkup(
      <ExplanationBody data={explanationDto()} evidenceId={null} evidence={null} />,
    );
    expect(html).toContain('无法判断（系统不编造）');
  });

  it('⑧ AI 未参与 → AI 处置区显示说明而不是隐藏', () => {
    const html = renderToStaticMarkup(
      <ExplanationBody data={explanationDto()} evidenceId={null} evidence={null} />,
    );
    expect(html).toContain('AI 处置');
    expect(html).toContain('本次由规则生成，AI 未参与');
    expect(html).toContain('这是正常状态，不是降级故障');
    expect(html).toContain('本次没有 AI 建议被拒绝');
  });

  it('⑨ 点证据 → 以 ?evidence= 打开抽屉，不跳页', () => {
    const closed = renderToStaticMarkup(
      <ExplanationBody data={explanationDto()} evidenceId={null} evidence={null} />,
    );
    expect(closed).toContain('href="?evidence=ev-1"');
    expect(closed).not.toContain('证据详情');

    const opened = renderToStaticMarkup(
      <ExplanationBody data={explanationDto()} evidenceId="ev-1" evidence={EVIDENCE} />,
    );
    expect(opened).toContain('证据详情 · 阅读');
    expect(opened).toContain('evidenceId=ev-1');
    expect(opened).toContain('href="/planner/explain/pv-week"');
  });
});