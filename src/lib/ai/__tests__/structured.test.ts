import { describe, expect, it } from 'vitest';
import { buildMockPayload } from '../mock';
import { parseStructured } from '../structured';
import { AI_PROMPT_KINDS, type AiPromptMeta } from '../types';

const meta: AiPromptMeta = {
  mode: 'TUTOR',
  skill: 'WRITING',
  objective: '用 4 句话描述一次旅行',
  targetLevel: 'B1',
  baseline: 'Last year I go to the beach with my family.',
  taskInstructions: '描述一次难忘的旅行',
  diagnosisSummary: '时态不稳定',
  hintLevel: 2,
  retestQuestion: 'Describe a place you visited.',
  retestAnswer: 'I went to a small town last summer.',
  performanceType: 'immediate_retest',
  aidLevel: 'none',
  contextSummary: '轨道：IELTS；最近错误：时态',
};

describe('结构化输出协议', () => {
  it('七类 Mock 输出全部通过对应 schema', () => {
    for (const kind of AI_PROMPT_KINDS) {
      const result = parseStructured(kind, buildMockPayload(kind, meta));
      expect(result.ok, `${kind} 的 Mock 输出应合法`).toBe(true);
    }
  });

  it('诊断没有引用且未标注「证据不足」时拒绝', () => {
    const result = parseStructured('diagnosis', {
      summary: '整体可理解',
      observed_evidence: [],
      error_categories: [],
      hypotheses: [],
      confirmed_vs_uncertain: '不确定',
      strengths: ['愿意作答'],
      priority_issues: ['时态'],
      recommended_next_step: '先练习时态',
    });
    expect(result.ok).toBe(false);
  });

  it('诊断允许引用具体作答片段，或明确说「证据不足」', () => {
    const base = {
      observed_evidence: [],
      error_categories: [],
      hypotheses: [],
      confirmed_vs_uncertain: '不确定',
      strengths: [],
      priority_issues: [],
      recommended_next_step: '先完成独立作答',
    };
    expect(
      parseStructured('diagnosis', {
        ...base,
        summary: '证据不足：尚未提交作答。',
      }).ok,
    ).toBe(true);
    expect(
      parseStructured('diagnosis', {
        ...base,
        summary: '整体可理解。',
        observed_evidence: [{ quote: 'I go to the beach', location: '第一句' }],
      }).ok,
    ).toBe(true);
  });

  it('1–2 级提示泄露答案时拒绝，3 级允许', () => {
    expect(
      parseStructured('hint', {
        hint_level: 1,
        hint_text: '直接写法是……',
        reveals_answer: true,
      }).ok,
    ).toBe(false);
    expect(
      parseStructured('hint', {
        hint_level: 2,
        hint_text: '看第二个句子',
        reveals_answer: true,
      }).ok,
    ).toBe(false);
    expect(
      parseStructured('hint', {
        hint_level: 3,
        hint_text: '完整思路：先写主干。',
        reveals_answer: true,
      }).ok,
    ).toBe(true);
  });

  it('评估结论不允许冒充官方分数', () => {
    const base = {
      performance_type: 'immediate_retest',
      aid_level: 'none',
      rubric_scores: [{ criterion: '任务回应', score: 1 }],
      evidence_refs: [],
      confidence: 'MEDIUM',
      limitations: 'AI 辅助评估，不是官方成绩。',
    };
    expect(parseStructured('assessment', { ...base, is_official_score: true }).ok).toBe(false);
    expect(parseStructured('assessment', { ...base, is_official_score: false }).ok).toBe(true);
  });
});