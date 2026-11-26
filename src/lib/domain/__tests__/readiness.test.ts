import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeReadiness as evaluateReadiness,
  type EvidenceDistribution,
  type ReadinessInput,
  type ReadinessSnapshot,
  type RetestOutcome,
  type SkillCoverage,
} from '@/lib/domain/readiness';

const SKILLS = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as const;
const snapshot: ReadinessSnapshot = {
  ruleVersion: 'v2.7.1-readiness-1', dataSnapshotId: 'snapshot-1', computedAt: '2026-11-25T10:00:00Z',
  blueprint: { id: 'bp-1', code: 'diag-core', version: '1.0', stageProfileCode: 'A0_A2' },
  coverageBySkill: {}, invalidSamples: [],
};
function computeReadiness(input: ReadinessInput) {
  return evaluateReadiness(input, snapshot);
}
function dist(): EvidenceDistribution {
  return { baseline: 1, immediate: 1, delayed: 0, applied: 0, transfer: 0, independent: 2, independentEvidenceRefs: ['ev-a', 'ev-b'] };
}
function coverage(completed = 1, required = 1, ratio: number | null = completed / required): SkillCoverage {
  return {
    skill: 'LISTENING', completed, required, coverageRatio: ratio,
    missingSubskills: completed < required ? ['detail_understanding'] : [],
    dimensions: [{ skill: 'LISTENING', subskill: 'detail_understanding', completed: completed > 0, evidenceRefs: completed > 0 ? ['ev-detail'] : [], sourceKinds: completed > 0 ? ['客观题'] : [], itemCodes: ['L-DETAIL-A2'] }],
    invalidSamples: [],
  };
}
function retest(type: RetestOutcome['retestType'], overrides: Partial<RetestOutcome> = {}): RetestOutcome {
  return {
    id: `r-${type}`, retestType: type, skill: 'LISTENING', status: 'DONE', score: 2,
    materialRef: 'parallel-material', evidenceId: `ev-${type}`, parentEvidenceId: 'parent-1',
    valid: true, independent: true, contextChanged: true, intervalMet: true, invalidReason: null,
    ...overrides,
  };
}
function readyInput(): ReadinessInput {
  return {
    stageId: 'stage-1', stageStart: '2026-01-01', asOfDate: '2026-11-25',
    officialGaps: [], officialUncertainties: [],
    evidenceBySkill: Object.fromEntries(SKILLS.map((skill) => [skill, dist()])),
    retestOutcomes: [retest('DELAYED'), retest('APPLIED')],
    distinctSources: SKILLS.map((skill) => ({ skill, sourceRefs: ['src-a', 'src-b'] })),
    coverageBySkill: Object.fromEntries(SKILLS.map((skill) => [skill, { ...coverage(), skill }])),
    readErrors: [],
  };
}
function dimension(result: ReturnType<typeof computeReadiness>, code: string) {
  return result.dimensions.find((row) => row.code === code);
}

describe('T09 computeReadiness（AC-03 / AC-14）', () => {
  it('① ReadinessInput 类型上无法传入 daysCompleted/completionRate/aiScore', () => {
    const base = readyInput();
    // @ts-expect-error
    computeReadiness({ ...base, daysCompleted: 90 });
    // @ts-expect-error
    computeReadiness({ ...base, completionRate: 0.8 });
    // @ts-expect-error
    computeReadiness({ ...base, aiScore: 9.0 });
    expect(base.stageId).toBe('stage-1');
  });

  it('①b @ts-expect-error 恰好 3 条，且每条下一行都是 computeReadiness 调用', () => {
    const lines = readFileSync(fileURLToPath(new URL('./readiness.test.ts', import.meta.url)), 'utf8').split('\n');
    const directives = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^[ \t]*\/\/[ \t]*@ts-expect-error/.test(line));
    expect(directives).toHaveLength(3);
    for (const { index } of directives) expect(lines[index + 1]).toMatch(/computeReadiness\(/);
  });

  it('② D4 缺失 → NEED_MORE_EVIDENCE，其余 PASS', () => {
    const input = readyInput();
    input.retestOutcomes = [retest('DELAYED', { status: 'PENDING', score: null, evidenceId: null }), retest('APPLIED')];
    const result = computeReadiness(input);
    expect(result.outcome).toBe('NEED_MORE_EVIDENCE');
    expect(dimension(result, 'D4_DELAYED_RETENTION')?.status).toBe('INSUFFICIENT');
  });

  it('③ 任一维读取失败 → READ_ERROR 且整体不 Ready', () => {
    for (const code of ['D1_EVIDENCE_COVERAGE', 'D2_CROSS_SOURCE_CONSISTENCY', 'D3_INDEPENDENT_COMPLETION', 'D4_DELAYED_RETENTION', 'D5_TRANSFER_EVIDENCE'] as const) {
      const input = readyInput();
      input.readErrors = [code];
      const result = computeReadiness(input);
      expect(result.outcome).toBe('NEED_MORE_EVIDENCE');
      expect(dimension(result, code)?.status).toBe('READ_ERROR');
    }
  });

  it('④ 五维全 PASS → READY_FOR_REVIEW', () => {
    const result = computeReadiness(readyInput());
    expect(result.outcome).toBe('READY_FOR_REVIEW');
    expect(result.dimensions.every((row) => row.status === 'PASS')).toBe(true);
    expect(result.snapshot.dataSnapshotId).toBe('snapshot-1');
  });

  it('⑤ D4/D5 已观察未达标 → NEED_TARGETED_PRACTICE', () => {
    for (const type of ['DELAYED', 'TRANSFER'] as const) {
      const input = readyInput();
      input.retestOutcomes = [retest('DELAYED'), retest('APPLIED'), retest('TRANSFER')]
        .map((row) => type === 'DELAYED'
          ? row.retestType === 'DELAYED' ? { ...row, score: 0 } : row
          : row.retestType === 'APPLIED' || row.retestType === 'TRANSFER' ? { ...row, score: 0 } : row);
      expect(computeReadiness(input).outcome).toBe('NEED_TARGETED_PRACTICE');
    }
  });

  it('⑥ D1 缺必测维度 → INSUFFICIENT，已知零完成显示 0/1（0%）', () => {
    const input = readyInput();
    input.coverageBySkill.LISTENING = coverage(0, 1, 0);
    input.coverageBySkill.LISTENING.missingSubskills = ['key_information'];
    const result = computeReadiness(input);
    expect(dimension(result, 'D1_EVIDENCE_COVERAGE')?.status).toBe('INSUFFICIENT');
    expect(dimension(result, 'D1_EVIDENCE_COVERAGE')?.detail).toContain('0/1（0%）');
  });

  it('D1 分母未知 → INSUFFICIENT；已知分母零完成才是 0%', () => {
    const unknown = readyInput();
    unknown.coverageBySkill.LISTENING = coverage(0, 0, null);
    expect(dimension(computeReadiness(unknown), 'D1_EVIDENCE_COVERAGE')?.detail).toContain('分母未知');
    const zero = readyInput();
    zero.coverageBySkill.LISTENING = coverage(0, 1, 0);
    zero.coverageBySkill.LISTENING.dimensions = [];
    expect(dimension(computeReadiness(zero), 'D1_EVIDENCE_COVERAGE')?.detail).toContain('0%');
  });

  it('D1 无缺口不等于自动完全覆盖', () => {
    const input = readyInput();
    input.coverageBySkill.READING = coverage(1, 2, 0.5);
    input.coverageBySkill.READING.missingSubskills = ['gist_understanding'];
    expect(dimension(computeReadiness(input), 'D1_EVIDENCE_COVERAGE')?.status).toBe('INSUFFICIENT');
  });

  it('D2 来源不足/方向未知/方向冲突分别为 INSUFFICIENT/INSUFFICIENT/FAIL', () => {
    const input = readyInput();
    input.distinctSources[0]!.sourceRefs = ['same-ai-same-answer'];
    expect(dimension(computeReadiness(input), 'D2_CROSS_SOURCE_CONSISTENCY')?.status).toBe('INSUFFICIENT');
    input.distinctSources = readyInput().distinctSources;
    input.officialGaps = [{ ...gapDraft('LISTENING'), coverageRatio: null }];
    expect(dimension(computeReadiness(input), 'D2_CROSS_SOURCE_CONSISTENCY')?.status).toBe('INSUFFICIENT');
    input.officialGaps = [{ ...gapDraft('LISTENING'), coverageRatio: 0.9 }, { ...gapDraft('LISTENING'), coverageRatio: 0.3 }];
    expect(dimension(computeReadiness(input), 'D2_CROSS_SOURCE_CONSISTENCY')?.status).toBe('FAIL');
  });

  it('D2 来源观察未知为 INSUFFICIENT，不同来源方向冲突为 FAIL', () => {
    const input = readyInput();
    input.distinctSources[0]!.observations = [
      { sourceRef: 'src-a', direction: 'UNKNOWN', evidenceRefs: ['ev-a'] },
      { sourceRef: 'src-b', direction: 'MEETS', evidenceRefs: ['ev-b'] },
    ];
    expect(dimension(computeReadiness(input), 'D2_CROSS_SOURCE_CONSISTENCY')?.status).toBe('INSUFFICIENT');
    input.distinctSources[0]!.observations[0]!.direction = 'BELOW';
    expect(dimension(computeReadiness(input), 'D2_CROSS_SOURCE_CONSISTENCY')?.status).toBe('FAIL');
  });

  it('D3 有辅助/无证据/低于阈值分别为 INSUFFICIENT/FAIL', () => {
    const missing = readyInput();
    missing.evidenceBySkill.WRITING = { ...dist(), independent: 0, independentEvidenceRefs: [] };
    expect(dimension(computeReadiness(missing), 'D3_INDEPENDENT_COMPLETION')?.status).toBe('INSUFFICIENT');
    const low = readyInput();
    low.evidenceBySkill.WRITING = { ...dist(), independent: 1, independentEvidenceRefs: ['ev-one'] };
    expect(dimension(computeReadiness(low), 'D3_INDEPENDENT_COMPLETION')?.status).toBe('FAIL');
  });

  it('D4 原题/提前/有辅助/无效样本均不进入保持证据', () => {
    for (const overrides of [{ contextChanged: false }, { intervalMet: false }, { independent: false }, { valid: false }]) {
      const input = readyInput();
      input.retestOutcomes = [retest('DELAYED', overrides), retest('APPLIED')];
      expect(dimension(computeReadiness(input), 'D4_DELAYED_RETENTION')?.status).toBe('INSUFFICIENT');
    }
  });

  it('D5 重复原题或缺少新情境不能作为迁移证据', () => {
    const input = readyInput();
    input.retestOutcomes = [retest('DELAYED'), retest('TRANSFER', { contextChanged: false })];
    expect(dimension(computeReadiness(input), 'D5_TRANSFER_EVIDENCE')?.status).toBe('INSUFFICIENT');
  });

  it('USER_APPROVED_TRANSITION 不由 computeReadiness 返回', () => {
    expect(computeReadiness(readyInput()).outcome).not.toBe('USER_APPROVED_TRANSITION');
  });
});

function gapDraft(skill: string) {
  return {
    dimensionKind: 'OFFICIAL' as const, skill, subskill: '', kind: 'GAP' as const,
    confidence: 'HIGH' as const, evidenceCount: 3, independentCount: 2, freshnessDays: 3,
    coverageRatio: 0.9, severity: 0.4, reason: '测试缺口', evidenceIds: ['ev-1'],
    missingEvidence: [], evidenceQuestions: 10, repeatedErrorCount: 0, stale: false,
  };
}
