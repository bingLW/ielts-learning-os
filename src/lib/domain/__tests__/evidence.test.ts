/**
 * 被测文件：src/lib/domain/evidence.ts
 * 规则来源：v2.2 §5（证据生命周期）、§9（复测与迁移）、§12（预算融合）、§15（口径）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildRetestPlan,
  chainStageIndex,
  checkTypeAssistance,
  isIndependent,
  isKnownAssistanceLevel,
  maxEvidenceScore,
  nextChainType,
  parseEvidenceCondition,
  previewOutput,
  recommendedEvidenceLevel,
  summarizeEvidence,
} from '../evidence';
import { EVIDENCE_OUTPUT_PREVIEW_CHARS } from '../../constants';
import type { EvidenceSkill } from '../../types';

describe('recommendedEvidenceLevel（v2.2 §12 预算融合）', () => {
  it('≤15 分钟不要求证据链', () => {
    expect(recommendedEvidenceLevel(0)).toBeNull();
    expect(recommendedEvidenceLevel(15)).toBeNull();
  });

  it('16–59 分钟 → Quick；60–179 → Standard；≥180 → Full', () => {
    expect(recommendedEvidenceLevel(16)).toBe('QUICK');
    expect(recommendedEvidenceLevel(59)).toBe('QUICK');
    expect(recommendedEvidenceLevel(60)).toBe('STANDARD');
    expect(recommendedEvidenceLevel(179)).toBe('STANDARD');
    expect(recommendedEvidenceLevel(180)).toBe('FULL');
    expect(recommendedEvidenceLevel(240)).toBe('FULL');
  });

  it('非法输入返回 null', () => {
    expect(recommendedEvidenceLevel(-1)).toBeNull();
    expect(recommendedEvidenceLevel(Number.NaN)).toBeNull();
  });
});

describe('独立性与评分上限', () => {
  it('只有 A0 计为独立表现', () => {
    expect(isIndependent('A0')).toBe(true);
    expect(isIndependent('A1')).toBe(false);
    expect(isIndependent('A4')).toBe(false);
  });

  it('2 分只允许 A0；其余最高 1 分', () => {
    expect(maxEvidenceScore('A0')).toBe(2);
    expect(maxEvidenceScore('A1')).toBe(1);
    expect(maxEvidenceScore('A4')).toBe(1);
  });

  it('识别合法辅助级别', () => {
    expect(isKnownAssistanceLevel('A3')).toBe(true);
    expect(isKnownAssistanceLevel('A5')).toBe(false);
  });
});

describe('checkTypeAssistance（基线/辅助版不能混用）', () => {
  it('基线必须 A0', () => {
    expect(checkTypeAssistance('BASELINE', 'A0')).toEqual({ ok: true });
    const bad = checkTypeAssistance('BASELINE', 'A2');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('BASELINE_NOT_INDEPENDENT');
  });

  it('辅助版本必须确有工具介入', () => {
    const bad = checkTypeAssistance('ASSISTED', 'A0');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('ASSISTED_WITHOUT_SUPPORT');
    expect(checkTypeAssistance('ASSISTED', 'A3')).toEqual({ ok: true });
  });
});

describe('证据链顺序', () => {
  it('E0→E5 索引递增', () => {
    expect(chainStageIndex('BASELINE')).toBe(0);
    expect(chainStageIndex('ASSISTED')).toBe(1);
    expect(chainStageIndex('IMMEDIATE_RETEST')).toBe(2);
    expect(chainStageIndex('DELAYED_RETEST')).toBe(3);
    expect(chainStageIndex('APPLIED_TASK')).toBe(4);
    expect(chainStageIndex('TRANSFER')).toBe(5);
  });

  it('下一阶段正确，TRANSFER 之后为空', () => {
    expect(nextChainType('BASELINE')).toBe('ASSISTED');
    expect(nextChainType('ASSISTED')).toBe('IMMEDIATE_RETEST');
    expect(nextChainType('IMMEDIATE_RETEST')).toBe('DELAYED_RETEST');
    expect(nextChainType('DELAYED_RETEST')).toBe('APPLIED_TASK');
    expect(nextChainType('APPLIED_TASK')).toBe('TRANSFER');
    expect(nextChainType('TRANSFER')).toBeNull();
  });
});

describe('buildRetestPlan（§9 复测偏移与幂等键）', () => {
  it('基线可排 4 段：0/7/30/84 天', () => {
    const plan = buildRetestPlan('ev-1', 'BASELINE', '2026-11-19');
    expect(plan.map((step) => step.retestType)).toEqual([
      'IMMEDIATE',
      'DELAYED',
      'APPLIED',
      'TRANSFER',
    ]);
    expect(plan.map((step) => step.dueDate)).toEqual([
      '2026-11-19',
      '2026-11-26',
      '2026-12-19',
      '2027-02-11',
    ]);
    expect(plan[0].idempotencyKey).toBe('ev-1:IMMEDIATE:2026-11-19');
    expect(plan[0].estMinutes).toBeGreaterThan(0);
  });

  it('只排比父证据更靠后的阶段', () => {
    expect(buildRetestPlan('ev-2', 'IMMEDIATE_RETEST', '2026-11-19').map((s) => s.retestType)).toEqual([
      'DELAYED',
      'APPLIED',
      'TRANSFER',
    ]);
    expect(buildRetestPlan('ev-3', 'DELAYED_RETEST', '2026-11-19').map((s) => s.retestType)).toEqual([
      'APPLIED',
      'TRANSFER',
    ]);
    expect(buildRetestPlan('ev-4', 'APPLIED_TASK', '2026-11-19').map((s) => s.retestType)).toEqual([
      'TRANSFER',
    ]);
    expect(buildRetestPlan('ev-5', 'TRANSFER', '2026-11-19')).toEqual([]);
  });

  it('同一父证据+类型+日期 → 幂等键稳定', () => {
    const a = buildRetestPlan('ev-9', 'BASELINE', '2026-11-19');
    const b = buildRetestPlan('ev-9', 'BASELINE', '2026-11-19');
    expect(a.map((s) => s.idempotencyKey)).toEqual(b.map((s) => s.idempotencyKey));
  });
});

describe('previewOutput', () => {
  it('折叠空白并截断', () => {
    expect(previewOutput('  hello \n world  ')).toBe('hello world');
    const long = 'x'.repeat(EVIDENCE_OUTPUT_PREVIEW_CHARS + 20);
    const result = previewOutput(long);
    expect(result).not.toBeNull();
    expect(result?.endsWith('…')).toBe(true);
    expect(result?.length).toBe(EVIDENCE_OUTPUT_PREVIEW_CHARS + 1);
  });

  it('空值返回 null', () => {
    expect(previewOutput(null)).toBeNull();
    expect(previewOutput('   ')).toBeNull();
  });
});

describe('parseEvidenceCondition', () => {
  it('合法 JSON 正常还原', () => {
    const raw = JSON.stringify({
      prompt: 'Describe your week',
      materialSource: 'Cambridge 18 Test 1',
      timeLimitMinutes: 15,
      toolsAllowed: ['dictionary'],
      audience: 'examiner',
      environment: 'quiet room',
    });
    expect(parseEvidenceCondition(raw)).toEqual({
      prompt: 'Describe your week',
      materialSource: 'Cambridge 18 Test 1',
      timeLimitMinutes: 15,
      toolsAllowed: ['dictionary'],
      audience: 'examiner',
      environment: 'quiet room',
    });
  });

  it('脏数据退回 null/默认值', () => {
    expect(parseEvidenceCondition(null)).toBeNull();
    expect(parseEvidenceCondition('not-json')).toBeNull();
    expect(parseEvidenceCondition('[1,2]')).toBeNull();
    expect(parseEvidenceCondition('{"toolsAllowed":[1,"x"],"timeLimitMinutes":"15"}')).toEqual({
      prompt: null,
      materialSource: null,
      timeLimitMinutes: null,
      toolsAllowed: ['x'],
      audience: null,
      environment: null,
    });
  });
});

describe('summarizeEvidence（证据覆盖率，不是能力分数）', () => {
  const rows = [
    { skill: 'LISTENING' as EvidenceSkill, evidenceType: 'BASELINE' as const, assistanceLevel: 'A0' as const },
    { skill: 'LISTENING' as EvidenceSkill, evidenceType: 'ASSISTED' as const, assistanceLevel: 'A2' as const },
    { skill: 'LISTENING' as EvidenceSkill, evidenceType: 'IMMEDIATE_RETEST' as const, assistanceLevel: 'A0' as const },
    { skill: 'LISTENING' as EvidenceSkill, evidenceType: 'DELAYED_RETEST' as const, assistanceLevel: 'A0' as const },
    { skill: 'READING' as EvidenceSkill, evidenceType: 'BASELINE' as const, assistanceLevel: 'A0' as const },
    { skill: 'READING' as EvidenceSkill, evidenceType: 'TRANSFER' as const, assistanceLevel: 'A0' as const, archived: true },
  ];

  it('只统计活动证据，归档不计入', () => {
    const stats = summarizeEvidence(rows);
    expect(stats.total).toBe(6);
    expect(stats.active).toBe(5);
    expect(stats.bySkill.READING).toBe(1);
    expect(stats.byType.TRANSFER).toBe(0);
  });

  it('独立率只在活动证据上计算', () => {
    const stats = summarizeEvidence(rows);
    expect(stats.independent).toBe(4);
    expect(stats.independentRate).toBeCloseTo(0.8);
  });

  it('核心四段齐全才算链完整', () => {
    const stats = summarizeEvidence(rows);
    expect(stats.chainSkills).toEqual(['LISTENING']);
  });

  it('空数据时独立率为 null（不补 0）', () => {
    const stats = summarizeEvidence([]);
    expect(stats.independentRate).toBeNull();
    expect(stats.chainSkills).toEqual([]);
  });
});
