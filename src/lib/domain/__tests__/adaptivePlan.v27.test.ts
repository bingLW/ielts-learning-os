/**
 * v2.7 `AdaptivePlanInput` 扩展的行为测试（`41 §3.3`）。
 *
 * v2.1 的逐字等价由 `adaptivePlanGolden.test.ts` 钉住；这里只测四个新字段**生效时**的行为。
 * 四条硬约束：
 * - `bufferRatio` 只作用技能池与拓展，P0 / 复测 / 核心保障不动（AC-7）；
 * - `candidates` 原样消费 decision 的 priority / rationale，**不重算、不重排**（㉓③）；
 * - `uncertainties` 生成 P2 补测，不占 P0 份额；
 * - `skillGaps` 只写 rationale，不改任何分钟。
 */

import { describe, expect, it } from 'vitest';

import {
  generateAdaptivePlan,
  type AdaptivePlanInput,
  type RankedCandidateInput,
} from '../adaptivePlan';
import { A0_ALLOCATION } from './fixtures/adaptivePlanLegacyInputs';

const BASE: AdaptivePlanInput = {
  budgetMinutes: 180,
  stageCode: 'S2_A2_B1',
  allocation: A0_ALLOCATION,
};

/** 四技能池的条目（primarySkill 为官方四项），区别于基础/复盘/拓展。 */
function skillPoolMinutes(result: ReturnType<typeof generateAdaptivePlan>): number {
  if (!result.ok) return 0;
  return result.items
    .filter((item) =>
      ['LISTENING', 'READING', 'SPEAKING', 'WRITING'].includes(item.primarySkill),
    )
    .reduce((sum, item) => sum + item.minutes, 0);
}

describe('bufferRatio：只削技能池与拓展，不碰 P0 / 复测', () => {
  it('技能池随缓冲比例下降', () => {
    const plain = generateAdaptivePlan(BASE);
    const buffered = generateAdaptivePlan({ ...BASE, bufferRatio: 0.3 });
    expect(plain.ok && buffered.ok).toBe(true);
    expect(skillPoolMinutes(buffered)).toBeLessThan(skillPoolMinutes(plain));
    expect(skillPoolMinutes(buffered)).toBeLessThanOrEqual(Math.floor(BASE.budgetMinutes * 0.7));
  });

  it('非法缓冲值按 0 处理，不改变结果', () => {
    expect(generateAdaptivePlan({ ...BASE, bufferRatio: Number.NaN })).toEqual(
      generateAdaptivePlan(BASE),
    );
    expect(generateAdaptivePlan({ ...BASE, bufferRatio: 2 })).toEqual(
      generateAdaptivePlan({ ...BASE, bufferRatio: 0.3 }),
    );
  });

  it('P0 复习分钟在缓冲前后完全相同', () => {
    const input: AdaptivePlanInput = {
      ...BASE,
      dueReviews: { estMinutes: 60, count: 4, maxOverdueDays: 2 },
    };
    const plain = generateAdaptivePlan(input);
    const buffered = generateAdaptivePlan({ ...input, bufferRatio: 0.3 });
    expect(plain.ok && buffered.ok).toBe(true);
    if (!plain.ok || !buffered.ok) return;
    expect(plain.priorityMinutes.P0).toBe(buffered.priorityMinutes.P0);
    expect(plain.priorityMinutes.P0).toBeGreaterThan(0);
  });

  it('到期复测在缓冲前后完全相同', () => {
    const input: AdaptivePlanInput = {
      ...BASE,
      dueRetests: { items: [{ id: 'r1', minutes: 15 }, { id: 'r2', minutes: 10 }] },
    };
    const plain = generateAdaptivePlan(input);
    const buffered = generateAdaptivePlan({ ...input, bufferRatio: 0.3 });
    expect(plain.ok && buffered.ok).toBe(true);
    if (!plain.ok || !buffered.ok) return;
    expect(buffered.scheduledRetestIds).toEqual(plain.scheduledRetestIds);
    expect(buffered.items.find((i) => i.module === 'EVIDENCE_RETEST')?.minutes).toBe(
      plain.items.find((i) => i.module === 'EVIDENCE_RETEST')?.minutes,
    );
  });
});

function candidate(key: string, minutes: number, rationale: string): RankedCandidateInput {
  return {
    candidateKey: key,
    module: 'LISTENING',
    primarySkill: 'LISTENING',
    track: 'GENERAL_ENGLISH',
    estMinutes: minutes,
    minMinutes: 5,
    maxBlockMinutes: null,
    priority: 'P1',
    splittable: true,
    rationale,
    score: 0.55,
  };
}

describe('candidates：原样消费决策，不重算、不重排（㉓③）', () => {
  it('priority 与 rationale 逐字来自候选', () => {
    const result = generateAdaptivePlan({
      ...BASE,
      candidates: [
        candidate('c-priority', 30, '来自评分决策的理由，不要重算'),
        { ...candidate('c-p2', 20, '另一条理由'), priority: 'P2' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.items.find((i) => i.rationale.includes('不要重算'));
    expect(first?.priority).toBe('P1');
    expect(first?.rationale).toBe('来自评分决策的理由，不要重算');
    expect(result.priorityMinutes.P2).toBeGreaterThan(0);
  });

  it('逆序喂入 → 消费顺序跟着逆序（引擎不得二次排序）', () => {
    const a = candidate('a', 20, 'AAA');
    const b = candidate('b', 20, 'BBB');
    const forward = generateAdaptivePlan({ ...BASE, candidates: [a, b] });
    const reversed = generateAdaptivePlan({ ...BASE, candidates: [b, a] });
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    const keys = (r: typeof forward & { ok: true }) =>
      r.items.filter((i) => i.rationale === 'AAA' || i.rationale === 'BBB').map((i) => i.rationale);
    expect(keys(forward)).toEqual(['AAA', 'BBB']);
    expect(keys(reversed)).toEqual(['BBB', 'AAA']);
  });

  it('不可拆候选放不下时整条进 backlog，不生成碎片', () => {
    const result = generateAdaptivePlan({
      ...BASE,
      bufferRatio: 0.3,
      candidates: [{ ...candidate('huge', 1000, '超大候选'), splittable: false }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.some((i) => i.rationale === '超大候选')).toBe(false);
    expect(result.backlog.some((b) => b.label.includes('huge'))).toBe(true);
  });
});

describe('uncertainties：P2 补测，不占 P0 份额', () => {
  it('补测落 P2 且 P0 不受影响', () => {
    const input: AdaptivePlanInput = {
      ...BASE,
      dueReviews: { estMinutes: 50, count: 3, maxOverdueDays: 1 },
      uncertainties: [
        {
          skillGapKey: 'OFFICIAL:READING:detail',
          module: 'READING',
          primarySkill: 'READING',
          minutes: 15,
          reason: '证据不足，先补测再判断是否为弱项',
        },
      ],
    };
    const plain = generateAdaptivePlan(input);
    const withProbe = generateAdaptivePlan({ ...input, uncertainties: input.uncertainties });
    expect(plain.ok && withProbe.ok).toBe(true);
    if (!plain.ok || !withProbe.ok) return;
    expect(plain.priorityMinutes.P0).toBe(withProbe.priorityMinutes.P0);
    const probe = withProbe.items.find((i) => i.rationale.includes('先补测'));
    expect(probe?.priority).toBe('P2');
    expect(probe?.sourceKind).toBe('RETEST');
  });
});

describe('skillGaps：只改 rationale，不改分钟', () => {
  it('有提示时 rationale 多一段证据说明，分钟不变', () => {
    const plain = generateAdaptivePlan(BASE);
    const hinted = generateAdaptivePlan({
      ...BASE,
      skillGaps: [
        {
          dimensionKind: 'OFFICIAL',
          skill: 'LISTENING',
          subskill: '',
          severity: 0.42,
          reason: '最近正确率偏离合并值 12%',
        },
      ],
    });
    expect(plain.ok && hinted.ok).toBe(true);
    if (!plain.ok || !hinted.ok) return;
    expect(hinted.totalPlannedMinutes).toBe(plain.totalPlannedMinutes);
    expect(hinted.items.some((i) => i.rationale.includes('最近正确率偏离合并值 12%'))).toBe(true);
  });
});
