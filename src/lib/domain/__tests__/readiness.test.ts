/**
 * T09 `computeReadiness` 纯函数单测（AC-14 核心，验收 ①–⑥）。
 *
 * 与 `stageGate` 的关系：本文件只测 readiness 自身，`importBoundary.test.ts` 负责
 * 断言两者互不 import。任何「阶段天数 / 完成率 / 单次 AI 分数」都**无法**进
 * `ReadinessInput`（F-2），因此这里不、也**不能**用这些值构造用例。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  computeReadiness,
  type EvidenceDistribution,
  type ReadinessInput,
} from '@/lib/domain/readiness';

const SKILLS = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as const;

function dist(): EvidenceDistribution {
  return { baseline: 1, immediate: 1, delayed: 0, applied: 0, transfer: 0, independent: 2 };
}

/** 五维全 PASS 的基准输入（每个用例按需覆盖某几项）。 */
function readyInput(): ReadinessInput {
  return {
    stageId: 'stage-1',
    stageStart: '2026-01-01',
    asOfDate: '2026-11-25',
    officialGaps: [],
    officialUncertainties: [],
    evidenceBySkill: Object.fromEntries(SKILLS.map((skill) => [skill, dist()])) as Record<
      string,
      EvidenceDistribution
    >,
    retestOutcomes: [
      { retestType: 'DELAYED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r-delayed' },
      { retestType: 'APPLIED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r-applied' },
    ],
    distinctSources: SKILLS.map((skill) => ({ skill, sourceRefs: ['src-a', 'src-b'] })),
    readErrors: [],
  };
}

function dimension(result: ReturnType<typeof computeReadiness>, code: string) {
  return result.dimensions.find((row) => row.code === code);
}

describe('T09 computeReadiness（AC-14 核心）', () => {
  it('① ReadinessInput 类型上无法传入 daysCompleted/completionRate/aiScore（@ts-expect-error 三连）', () => {
    const base = readyInput();

    // @ts-expect-error —— daysCompleted 不得进 ReadinessInput（F-2 类型级保障）
    computeReadiness({ ...base, daysCompleted: 90 });
    // @ts-expect-error —— completionRate 不得进 ReadinessInput
    computeReadiness({ ...base, completionRate: 0.8 });
    // @ts-expect-error —— aiScore 不得进 ReadinessInput
    computeReadiness({ ...base, aiScore: 9.0 });

    expect(base.stageId).toBe('stage-1');
  });

  it('①b @ts-expect-error 恰好 3 条，且每条下一行都是 computeReadiness( 调用', () => {
    const src = readFileSync(fileURLToPath(new URL('./readiness.test.ts', import.meta.url)), 'utf8');
    const lines = src.split('\n');
    const directives = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^[ \t]*\/\/[ \t]*@ts-expect-error/.test(line));
    expect(directives).toHaveLength(3);
    for (const { index } of directives) {
      expect(lines[index + 1]).toMatch(/computeReadiness\(/);
    }
  });

  it('② D4=INSUFFICIENT（延迟复测 0 条 DONE）→ NEED_MORE_EVIDENCE，即使 D1/D2/D3/D5 全 PASS', () => {
    const input = readyInput();
    input.retestOutcomes = [
      // 有一条延迟复测，但没 DONE —— 属于「证据不足」，不是「复测没达标」
      { retestType: 'DELAYED', skill: 'LISTENING', status: 'PENDING', score: null, materialRef: 'r1' },
      { retestType: 'APPLIED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r2' },
    ];

    const result = computeReadiness(input);
    expect(result.outcome).toBe('NEED_MORE_EVIDENCE');
    expect(dimension(result, 'D4_DELAYED_RETENTION')?.status).toBe('INSUFFICIENT');
    // D1/D2/D3/D5 都 PASS，唯独 D4 拖累 —— 证明「证据不足」先于一切 PASS
    expect(dimension(result, 'D1_EVIDENCE_COVERAGE')?.status).toBe('PASS');
    expect(dimension(result, 'D2_CROSS_SOURCE_CONSISTENCY')?.status).toBe('PASS');
    expect(dimension(result, 'D3_INDEPENDENT_COMPLETION')?.status).toBe('PASS');
    expect(dimension(result, 'D5_TRANSFER_EVIDENCE')?.status).toBe('PASS');
  });

  it('③ readErrors=[D5_TRANSFER_EVIDENCE] → NEED_MORE_EVIDENCE（缺数据不许给 Ready）', () => {
    const input = readyInput();
    input.readErrors = ['D5_TRANSFER_EVIDENCE'];

    const result = computeReadiness(input);
    expect(result.outcome).toBe('NEED_MORE_EVIDENCE');
    expect(dimension(result, 'D5_TRANSFER_EVIDENCE')?.status).toBe('READ_ERROR');
  });

  it('④ 五维全 PASS → READY_FOR_REVIEW', () => {
    const result = computeReadiness(readyInput());
    expect(result.outcome).toBe('READY_FOR_REVIEW');
    expect(result.dimensions).toHaveLength(5);
    for (const row of result.dimensions) {
      expect(row.status).toBe('PASS');
    }
    expect(result.unmet).toEqual([]);
  });

  it('⑤ D4 FAIL → NEED_TARGETED_PRACTICE（延迟复测做了但没达标）', () => {
    const input = readyInput();
    input.retestOutcomes = [
      { retestType: 'DELAYED', skill: 'LISTENING', status: 'DONE', score: 0, materialRef: 'r1' },
      { retestType: 'APPLIED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r2' },
    ];

    const result = computeReadiness(input);
    expect(result.outcome).toBe('NEED_TARGETED_PRACTICE');
    expect(dimension(result, 'D4_DELAYED_RETENTION')?.status).toBe('FAIL');
  });

  it('⑤b D5 FAIL → NEED_TARGETED_PRACTICE（迁移复测做了但没达标）', () => {
    const input = readyInput();
    input.retestOutcomes = [
      { retestType: 'DELAYED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r1' },
      { retestType: 'TRANSFER', skill: 'LISTENING', status: 'DONE', score: 0, materialRef: 'r2' },
    ];

    const result = computeReadiness(input);
    expect(result.outcome).toBe('NEED_TARGETED_PRACTICE');
    expect(dimension(result, 'D5_TRANSFER_EVIDENCE')?.status).toBe('FAIL');
  });

  it('⑥ USER_APPROVED_TRANSITION 不由 computeReadiness 返回（四个可达结论穷举）', () => {
    const ready = readyInput();

    const needMore = readyInput();
    needMore.retestOutcomes = [
      { retestType: 'DELAYED', skill: 'LISTENING', status: 'PENDING', score: null, materialRef: 'r1' },
    ];

    const targeted = readyInput();
    targeted.retestOutcomes = [
      { retestType: 'DELAYED', skill: 'LISTENING', status: 'DONE', score: 0, materialRef: 'r1' },
      { retestType: 'APPLIED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r2' },
    ];

    const continueCurrent = readyInput();
    // D3 FAIL（WRITING 只有 1 条 A0 证据，<2 但非 0），D4/D5 仍 PASS，
    // 无 INSUFFICIENT、无 readErrors、D4/D5 非 FAIL、也非全 PASS → CONTINUE_CURRENT。
    continueCurrent.retestOutcomes = [
      { retestType: 'DELAYED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r1' },
      { retestType: 'APPLIED', skill: 'LISTENING', status: 'DONE', score: 2, materialRef: 'r2' },
    ];
    continueCurrent.evidenceBySkill = {
      ...readyInput().evidenceBySkill,
      WRITING: { ...dist(), independent: 1 },
    };

    for (const input of [ready, needMore, targeted, continueCurrent]) {
      const result = computeReadiness(input);
      expect(result.outcome).not.toBe('USER_APPROVED_TRANSITION');
    }
  });

  it('D2 方向一致是真实判定：两缺口方向相反 → FAIL → CONTINUE_CURRENT', () => {
    const input = readyInput();
    input.officialGaps = [
      { ...gapDraft('LISTENING'), coverageRatio: 0.9 },
      { ...gapDraft('LISTENING'), coverageRatio: 0.3 },
    ];

    const result = computeReadiness(input);
    expect(dimension(result, 'D2_CROSS_SOURCE_CONSISTENCY')?.status).toBe('FAIL');
    expect(result.outcome).toBe('CONTINUE_CURRENT');
  });

  it('D2 方向一致：两缺口方向相同 → PASS', () => {
    const input = readyInput();
    input.officialGaps = [
      { ...gapDraft('LISTENING'), coverageRatio: 0.8 },
      { ...gapDraft('LISTENING'), coverageRatio: 0.9 },
    ];

    const result = computeReadiness(input);
    expect(dimension(result, 'D2_CROSS_SOURCE_CONSISTENCY')?.status).toBe('PASS');
  });

  it('D2 方向未知（coverageRatio=null）→ INSUFFICIENT，不是 PASS', () => {
    // 回归锁：null 是「方向未知」不是「覆盖不足」。若把 null 并进 COVERAGE，
    // directions 恒单元素 → D2 恒 PASS，这是假绿灯。必须显式 INSUFFICIENT。
    const input = readyInput();
    input.officialGaps = [{ ...gapDraft('LISTENING'), coverageRatio: null }];

    const result = computeReadiness(input);
    expect(dimension(result, 'D2_CROSS_SOURCE_CONSISTENCY')?.status).toBe('INSUFFICIENT');
    expect(result.outcome).toBe('NEED_MORE_EVIDENCE');
  });
});

/** 构造一条最小可用缺口（其余字段只保证类型与 D1/D2 需要的取值）。 */
function gapDraft(skill: string) {
  return {
    dimensionKind: 'OFFICIAL' as const,
    skill,
    subskill: '',
    kind: 'GAP' as const,
    confidence: 'HIGH' as const,
    evidenceCount: 3,
    independentCount: 2,
    freshnessDays: 3,
    coverageRatio: 0.9,
    severity: 0.4,
    reason: '测试缺口',
    evidenceIds: ['ev-1', 'ev-2'],
    missingEvidence: [],
    evidenceQuestions: 10,
    repeatedErrorCount: 0,
    stale: false,
  };
}
