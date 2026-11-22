import { describe, expect, it } from 'vitest';
import { buildMockPayload } from '../mock';
import { renderAiText } from '../orchestrator';
import type { AiPromptMeta } from '../types';

const meta: AiPromptMeta = {
  mode: 'DRILL',
  skill: 'WRITING',
  objective: '描述一次旅行',
  targetLevel: 'B1',
  baseline: 'Last year I go to the beach.',
  hintLevel: 2,
  retestQuestion: 'Describe a place you visited.',
  retestAnswer: 'I went to a small town.',
  performanceType: 'immediate_retest',
  aidLevel: 'none',
};

describe('结构化结果渲染', () => {
  it('练习文本只给题干，不泄露答案与解释', () => {
    const drill = buildMockPayload('drill', meta);
    const text = renderAiText('drill', drill);
    expect(text).toContain('【练习】');
    drill.items.forEach((item) => {
      expect(text).toContain(item.prompt);
      expect(text).not.toContain(item.answer);
      expect(text).not.toContain(item.explanation);
    });
  });

  it('评估文本明确标注为 AI 辅助且不冒充官方分数', () => {
    const text = renderAiText('assessment', buildMockPayload('assessment', meta));
    expect(text).toContain('【AI 辅助评估】');
    expect(text).toContain('不是官方 IELTS 分数');
  });

  it('诊断、提示、讲解与复盘的渲染包含关键段落', () => {
    expect(renderAiText('diagnosis', buildMockPayload('diagnosis', meta))).toContain('【诊断】');
    expect(renderAiText('hint', buildMockPayload('hint', meta))).toContain('【第 2 级提示】');
    expect(renderAiText('teaching', buildMockPayload('teaching', meta))).toContain('【讲解】');
    expect(renderAiText('reviewer', buildMockPayload('reviewer', meta))).toContain('【复盘】');
  });
});