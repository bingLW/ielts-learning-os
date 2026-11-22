/**
 * 练习两道闸门的单测（T11 验收：`canEnterPlacement` / `canAttachEvidence`）。
 *
 * 断言口径：
 * - `canEnterPlacement`：**只有 `approved`** 为 true；5 个已知状态逐一验证，
 *   未知值（null / 空串 / 乱码 / 其他状态名）必须落到 false（fail-closed）；
 * - `canAttachEvidence`：`PRACTICE_ONLY` 任何状态都允许；`ASSISTED` /
 *   `IMMEDIATE_RETEST` 只有 `approved` 允许；`BASELINE` **永远** false（ADR-08）；
 * - `isLowRiskPracticeAllowed`：draft / needs_review / approved 三种可练，其余不可。
 */

import { describe, expect, it } from 'vitest';
import {
  MATERIAL_EXERCISE_REVIEW_STATUSES,
  type MaterialExerciseReviewStatus,
} from '@/lib/constants';
import {
  canAttachEvidence,
  canEnterPlacement,
  decideExerciseUse,
  isLowRiskPracticeAllowed,
  normalizeExerciseReviewStatus,
  resolveAttemptEvidenceType,
} from '../materialExerciseGate';

const ALL_STATUSES = MATERIAL_EXERCISE_REVIEW_STATUSES;

/** 未知值样本：数据库里可能出现的各种"不像状态"的东西。 */
const UNKNOWN_VALUES: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['空串', ''],
  ['纯空白', '   '],
  ['其他状态名', 'pending'],
  ['标记残留', '[object Object]'],
  ['数字', 123],
  ['布尔', true],
  ['对象', {}],
];

describe('canEnterPlacement：只有 approved 能进正式排程/测评', () => {
  it('5 个已知状态逐一断言', () => {
    const expected: Record<MaterialExerciseReviewStatus, boolean> = {
      draft: false,
      needs_review: false,
      approved: true,
      rejected: false,
      retired: false,
    };
    for (const status of ALL_STATUSES) {
      expect(canEnterPlacement(status), `${status} 的结论应为 ${expected[status]}`).toBe(
        expected[status],
      );
    }
    // 防止将来加状态时忘了在这里表态
    expect(ALL_STATUSES).toHaveLength(5);
  });

  it('未知状态一律拒绝（fail-closed）', () => {
    for (const [label, value] of UNKNOWN_VALUES) {
      expect(canEnterPlacement(value as string | null | undefined), label).toBe(false);
    }
  });

  it('大小写/空白容错：` APPROVED ` 仍按 approved 处理', () => {
    // 这是有意的归一化：手工 SQL 或旧数据里的大小写差异不该把已审核题判成草稿。
    // 真正的"未知值"（如 'pending'）依然被拒，见上一条。
    expect(canEnterPlacement(' APPROVED ')).toBe(true);
    expect(canEnterPlacement('Approved')).toBe(true);
  });
});

describe('isLowRiskPracticeAllowed：draft / needs_review / approved 可练', () => {
  it('已知状态逐一断言', () => {
    expect(isLowRiskPracticeAllowed('draft')).toBe(true);
    expect(isLowRiskPracticeAllowed('needs_review')).toBe(true);
    expect(isLowRiskPracticeAllowed('approved')).toBe(true);
    expect(isLowRiskPracticeAllowed('rejected')).toBe(false);
    expect(isLowRiskPracticeAllowed('retired')).toBe(false);
  });

  it('未知状态一律不可作答', () => {
    for (const [label, value] of UNKNOWN_VALUES) {
      expect(isLowRiskPracticeAllowed(value as string | null | undefined), label).toBe(false);
    }
  });
});

describe('canAttachEvidence：PRACTICE_ONLY 恒可挂，其余看审核状态', () => {
  it('PRACTICE_ONLY 在任何审核状态下都允许', () => {
    for (const status of ALL_STATUSES) {
      expect(canAttachEvidence('PRACTICE_ONLY', status), status).toBe(true);
    }
    // 连未知状态也允许：它本来就只是"我练过"的留痕，不涉及证据强度
    expect(canAttachEvidence('PRACTICE_ONLY', 'pending')).toBe(true);
    expect(canAttachEvidence('PRACTICE_ONLY', null)).toBe(true);
  });

  it('ASSISTED / IMMEDIATE_RETEST 只有 approved 允许', () => {
    for (const type of ['ASSISTED', 'IMMEDIATE_RETEST']) {
      expect(canAttachEvidence(type, 'approved'), `${type} + approved`).toBe(true);
      for (const status of ['draft', 'needs_review', 'rejected', 'retired'] as const) {
        expect(canAttachEvidence(type, status), `${type} + ${status}`).toBe(false);
      }
      expect(canAttachEvidence(type, null), `${type} + null`).toBe(false);
      expect(canAttachEvidence(type, 'pending'), `${type} + pending`).toBe(false);
    }
  });

  it('BASELINE 永远不允许（ADR-08），即使题目已 approved', () => {
    for (const status of [...ALL_STATUSES, null, 'pending'] as const) {
      expect(canAttachEvidence('BASELINE', status), `BASELINE + ${String(status)}`).toBe(false);
    }
  });

  it('未知/空证据类型一律拒绝', () => {
    for (const type of ['', '   ', 'WHATEVER', 'PRACTICE_ONLY_2']) {
      expect(canAttachEvidence(type, 'approved'), type).toBe(false);
    }
    expect(canAttachEvidence(null, 'approved')).toBe(false);
    expect(canAttachEvidence(undefined, 'approved')).toBe(false);
  });
});

describe('resolveAttemptEvidenceType：落库值不接受"请求什么就写什么"', () => {
  it('未指定时按 PRACTICE_ONLY', () => {
    expect(resolveAttemptEvidenceType('draft')).toBe('PRACTICE_ONLY');
    expect(resolveAttemptEvidenceType('approved')).toBe('PRACTICE_ONLY');
  });

  it('请求 BASELINE → null（不降级、不静默改成别的类型）', () => {
    expect(resolveAttemptEvidenceType('approved', 'BASELINE')).toBeNull();
  });

  it('请求 ASSISTED 但题未审核 → null', () => {
    expect(resolveAttemptEvidenceType('draft', 'ASSISTED')).toBeNull();
    expect(resolveAttemptEvidenceType('approved', 'ASSISTED')).toBe('ASSISTED');
  });

  it('未知请求降级为 PRACTICE_ONLY', () => {
    expect(resolveAttemptEvidenceType('approved', 'WHATEVER')).toBe('PRACTICE_ONLY');
  });
});

describe('decideExerciseUse：一次给出三件事的结论', () => {
  it('approved：可练、可挂证据、可进排程', () => {
    const decision = decideExerciseUse('approved');
    expect(decision.canPractice).toBe(true);
    expect(decision.canAttachEvidence).toBe(true);
    expect(decision.evidenceType).toBe('PRACTICE_ONLY');
    expect(decision.canEnterPlacement).toBe(true);
    expect(decision.reasonZh).toBeNull();
  });

  it('draft：可练、可留痕，但不可进排程', () => {
    const decision = decideExerciseUse('draft');
    expect(decision.canPractice).toBe(true);
    expect(decision.canEnterPlacement).toBe(false);
    expect(decision.reasonZh).toBeNull();
  });

  it('rejected / retired：不可练且给出人话原因', () => {
    const rejected = decideExerciseUse('rejected');
    expect(rejected.canPractice).toBe(false);
    expect(rejected.canEnterPlacement).toBe(false);
    expect(rejected.canAttachEvidence).toBe(false);
    expect(rejected.evidenceType).toBeNull();
    expect(rejected.reasonZh).toContain('拒绝');

    const retired = decideExerciseUse('retired');
    expect(retired.canPractice).toBe(false);
    expect(retired.canAttachEvidence).toBe(false);
    expect(retired.evidenceType).toBeNull();
    expect(retired.reasonZh).toContain('退役');
  });

  it('未知状态：不可练，原因明确指向数据异常', () => {
    const decision = decideExerciseUse('pending');
    expect(decision.canPractice).toBe(false);
    expect(decision.canEnterPlacement).toBe(false);
    expect(decision.canAttachEvidence).toBe(false);
    expect(decision.evidenceType).toBeNull();
    expect(decision.reasonZh).toContain('无法识别');
    expect(normalizeExerciseReviewStatus('pending')).toBeNull();
  });
});
