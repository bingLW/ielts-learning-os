import { describe, expect, it } from 'vitest';
import { buildLearningContext, renderContextSummary, serializeContext } from '../context';

function errorRows() {
  return [
    { skill: 'READING', category: 'ATTENTION', summary: '阅读错 1', occurredOn: '2026-11-01' },
    { skill: 'WRITING', category: 'STRATEGY', summary: '写作错 1', occurredOn: '2026-11-02' },
    { skill: 'WRITING', category: 'STRATEGY', summary: '写作错 2', occurredOn: '2026-11-05' },
    { skill: 'WRITING', category: 'STRATEGY', summary: '写作错 3', occurredOn: '2026-11-04' },
    { skill: null, category: 'TECHNICAL', summary: '技术问题', occurredOn: '2026-11-06' },
    { skill: 'WRITING', category: 'ATTENTION', summary: '写作错 4', occurredOn: '2026-11-03' },
  ];
}

function evidenceRows() {
  return [
    { skill: 'LISTENING', evidenceType: 'BASELINE', score: 1, createdAt: '2026-11-01' },
    { skill: 'WRITING', evidenceType: 'ASSISTED', score: 1, createdAt: '2026-11-02' },
    { skill: 'WRITING', evidenceType: 'IMMEDIATE_RETEST', score: 2, createdAt: '2026-11-03' },
    { skill: 'WRITING', evidenceType: 'DELAYED_RETEST', score: 2, createdAt: '2026-11-04' },
  ];
}

const baseInput = {
  track: 'IELTS',
  ieltsTargetNote: '目标 7.0',
  skill: 'WRITING' as const,
  profile: { cefrEstimate: 'B1', confidence: 'MEDIUM' },
  stage: { name: '阶段 3', focus: 'Task 2', acceptance: '独立完成 250 词' },
  explainLanguage: 'ZH_MIXED',
  directTeachingAllowed: false,
  remainingMinutes: 25,
};

describe('Context Builder', () => {
  it('最近错误最多 5 条，最近证据最多 3 条', () => {
    const snapshot = buildLearningContext({
      ...baseInput,
      errors: errorRows(),
      evidence: evidenceRows(),
    });
    expect(snapshot.recentErrors).toHaveLength(5);
    expect(snapshot.recentEvidence).toHaveLength(3);
    expect(snapshot.limits).toEqual({ maxErrors: 5, maxEvidence: 3 });
  });

  it('同技能记录优先，其次按时间倒序', () => {
    const snapshot = buildLearningContext({
      ...baseInput,
      errors: errorRows(),
      evidence: evidenceRows(),
    });
    // 5 条上限内应包含全部 4 条 WRITING 错误，非 WRITING 只保留最新的一条。
    expect(snapshot.recentErrors.map((item) => item.summary)).not.toContain('阅读错 1');
    expect(snapshot.recentErrors[0]?.summary).toBe('写作错 2');
    expect(snapshot.recentEvidence.map((item) => item.evidenceType)).toEqual([
      'DELAYED_RETEST',
      'IMMEDIATE_RETEST',
      'ASSISTED',
    ]);
  });

  it('不注入未裁剪的长文本与技能字段', () => {
    const long = 'x'.repeat(500);
    const snapshot = buildLearningContext({
      ...baseInput,
      errors: [{ category: 'ATTENTION', summary: long, occurredOn: '2026-11-01' }],
    });
    expect(snapshot.recentErrors[0]?.summary.length).toBe(200);
    expect(snapshot.recentErrors[0]).not.toHaveProperty('skill');
  });

  it('摘要包含轨道、阶段、解释语言与剩余时间', () => {
    const snapshot = buildLearningContext(baseInput);
    const summary = renderContextSummary(snapshot);
    expect(summary).toContain('轨道：IELTS');
    expect(summary).toContain('阶段 3');
    expect(summary).toContain('解释语言：ZH_MIXED');
    expect(summary).toContain('剩余时间约 25 分钟');
  });

  it('序列化后可还原同一快照', () => {
    const snapshot = buildLearningContext({ ...baseInput, errors: errorRows() });
    expect(JSON.parse(serializeContext(snapshot))).toEqual(snapshot);
  });
});