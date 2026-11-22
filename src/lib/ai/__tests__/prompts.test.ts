import { describe, expect, it } from 'vitest';
import { fillTemplate, PROMPT_DEFINITIONS, renderPrompt } from '../prompts';
import { promptChecksum } from '../registry';
import { AI_PROMPT_KINDS, type AiPromptMeta } from '../types';

const meta: AiPromptMeta = {
  mode: 'SOCRATIC',
  skill: 'WRITING',
  objective: '用 4 句话描述一次旅行',
  targetLevel: 'B1',
  baseline: 'Last year I go to the beach.',
  taskInstructions: '描述一次难忘的旅行',
  diagnosisSummary: '时态不稳定',
  hintLevel: 2,
  retestQuestion: 'Describe a place you visited.',
  retestAnswer: 'I went to a small town.',
  performanceType: 'immediate_retest',
  aidLevel: 'none',
  contextSummary: '轨道：IELTS',
};

describe('提示词模板', () => {
  it('全部提示词都有唯一 promptKey 与测试样例', () => {
    const keys = new Set<string>();
    for (const kind of AI_PROMPT_KINDS) {
      const def = PROMPT_DEFINITIONS[kind];
      expect(def.promptKey).toMatch(/^ai\.(?:[a-z]+\.)*v1$/);
      expect(keys.has(def.promptKey)).toBe(false);
      keys.add(def.promptKey);
      expect(JSON.parse(def.testSamplesJson).length).toBeGreaterThan(0);
      expect(JSON.parse(def.outputSchemaJson)).toBeTypeOf('object');
    }
    expect(keys.size).toBe(AI_PROMPT_KINDS.length);
  });

  it('渲染后不残留未替换变量，且包含最小上下文', () => {
    const { system, user } = renderPrompt('hint', meta);
    expect(system).not.toContain('{{');
    expect(user).not.toContain('{{');
    expect(user).toContain('WRITING');
    expect(user).toContain('B1');
    expect(user).toContain('请求的提示级别：2');
    expect(user).toContain('<learner_answer>Last year I go to the beach.</learner_answer>');
  });

  it('长作答被截断后再进入提示词', () => {
    const longBaseline = 'x'.repeat(5000);
    const { user } = renderPrompt('diagnosis', { ...meta, baseline: longBaseline });
    expect(user).not.toContain('x'.repeat(2001));
    expect(user).toContain('x'.repeat(2000));
  });

  it('未知变量替换为空字符串', () => {
    expect(fillTemplate('a={{known}};b={{unknown}}', { known: '1' })).toBe('a=1;b=');
  });
});

describe('Prompt Registry 校验和', () => {
  it('同类稳定、异类不同，且为 16 位十六进制', () => {
    const hint = promptChecksum('hint');
    expect(hint).toBe(promptChecksum('hint'));
    expect(hint).toMatch(/^[0-9a-f]{16}$/);
    expect(hint).not.toBe(promptChecksum('diagnosis'));
  });
});