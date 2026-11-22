/**
 * 审核闸门的单元测试（纯函数，零 IO）。
 *
 * 这里断言的重点不是「实现怎么写」，而是三条产品口径：
 * 1. 有待审项 → 一定还在 `review_required`（不能被"丢弃计数"顶掉）；
 * 2. 审完了但**有结果被丢弃** → **绝不自动 ready**，必须用户显式确认；
 * 3. 审完了且全部可核验 → `ready`。
 *
 * 顺序不可调这件事单独用一条用例钉死（pending 与 dropped 同时存在时，
 * 必须走第 ① 条：先让人把要看的看完，再谈"部分可用"）。
 */

import { describe, expect, it } from 'vitest';
import { evaluateMaterialReviewGate, type ReviewGateInput } from '../materialReviewGate';

function gate(overrides: Partial<ReviewGateInput> = {}) {
  return evaluateMaterialReviewGate({
    pendingExtractions: 0,
    pendingExercises: 0,
    pendingCandidates: 0,
    droppedUnverifiable: 0,
    ...overrides,
  });
}

describe('evaluateMaterialReviewGate', () => {
  it('还有待审的提取结果 → review_required，并说明还剩什么', () => {
    const result = gate({ pendingExtractions: 3 });
    expect(result.nextStatus).toBe('review_required');
    expect(result.allReviewed).toBe(false);
    expect(result.requiresPartialConfirm).toBe(false);
    expect(result.pendingTotal).toBe(3);
    expect(result.reasonZh).toContain('3 条提取结果');
    expect(result.reasonZh).toContain('待你审核');
  });

  it('练习与词汇候选也计入待审总数，且分别点名', () => {
    const result = gate({ pendingExercises: 2, pendingCandidates: 4 });
    expect(result.pendingTotal).toBe(6);
    expect(result.nextStatus).toBe('review_required');
    expect(result.reasonZh).toContain('2 道练习题');
    expect(result.reasonZh).toContain('4 条词汇候选');
  });

  it('全部审完且有结果被丢弃 → 仍需用户确认，绝不自动 ready', () => {
    const result = gate({ droppedUnverifiable: 2 });
    expect(result.pendingTotal).toBe(0);
    expect(result.allReviewed).toBe(true);
    expect(result.requiresPartialConfirm).toBe(true);
    expect(result.nextStatus).toBe('review_required');
    expect(result.reasonZh).toContain('2 条结果因原文依据无法核验已丢弃');
  });

  it('全部审完且无丢弃 → ready', () => {
    const result = gate();
    expect(result.allReviewed).toBe(true);
    expect(result.requiresPartialConfirm).toBe(false);
    expect(result.nextStatus).toBe('ready');
    expect(result.reasonZh).toBe('全部 AI 结果已审核，原文依据核验通过');
  });

  it('顺序不可调：有丢弃但仍有待审项 → 先按「还没审完」处理', () => {
    const result = gate({ pendingExtractions: 1, droppedUnverifiable: 5 });
    expect(result.nextStatus).toBe('review_required');
    expect(result.allReviewed).toBe(false);
    // 关键：此时不该出现「确认部分可用」的入口
    expect(result.requiresPartialConfirm).toBe(false);
    expect(result.reasonZh).toContain('1 条提取结果');
  });

  it('计数异常（负数 / NaN）一律按 0 处理，不会把闸门判反', () => {
    const result = gate({
      pendingExtractions: Number.NaN,
      pendingExercises: -3,
      pendingCandidates: -1,
      droppedUnverifiable: Number.NaN,
    });
    expect(result.pendingTotal).toBe(0);
    expect(result.nextStatus).toBe('ready');
  });

  it('小数计数向下取整（计数只可能是整数，脏数据不该让结论漂移）', () => {
    const result = gate({ pendingExtractions: 1.9 });
    expect(result.pendingTotal).toBe(1);
    expect(result.nextStatus).toBe('review_required');
  });
});
