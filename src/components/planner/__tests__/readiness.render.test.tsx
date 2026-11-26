import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReadinessBody } from '../readiness/ReadinessBody';
import { READY_OUTCOME, type ReadinessSnapshot } from '@/lib/domain/readiness';
import type { ReadinessDimensionRowDto, ReadinessViewDto } from '@/lib/queries/planner';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

vi.mock('@/lib/actions/planner', () => ({
  reviewReadinessAction: vi.fn(),
  confirmStageTransitionAction: vi.fn(),
}));

function dimension(
  code: string,
  label: string,
  status: ReadinessDimensionRowDto['status'],
): ReadinessDimensionRowDto {
  return {
    code,
    label,
    status,
    detail: `${label}的依据说明`,
    evidenceRefs: status === 'INSUFFICIENT' || status === 'READ_ERROR' ? [] : ['ev-1'],
    suggestion: `${label}的补测建议`,
  };
}

const DIMENSIONS: ReadinessDimensionRowDto[] = [
  dimension('COVERAGE', '证据覆盖', 'PASS'),
  dimension('TRANSFER', '迁移表现', 'FAIL'),
  dimension('RETEST', '复测保持', 'INSUFFICIENT'),
  dimension('INDEPENDENCE', '独立完成', 'PASS'),
  dimension('REVIEW', '复习稳定', 'PASS'),
];

const INVALID_SAMPLE: ReadinessSnapshot['invalidSamples'][number] = {
  id: 'attempt-invalid-1',
  sourceType: 'ATTEMPT',
  skill: 'LISTENING',
  subskill: 'main_idea',
  reason: '未评分',
};

const SNAPSHOT: ReadinessSnapshot = {
  ruleVersion: 'v2.7.1-readiness-1',
  dataSnapshotId: 'snapshot-readiness-1',
  computedAt: '2026-11-24T09:00:00.123Z',
  blueprint: {
    id: 'blueprint-1',
    code: 'DIAGNOSTIC_BLUEPRINT',
    version: '2026.11',
    stageProfileCode: 'A2_B1',
  },
  coverageBySkill: {
    LISTENING: {
      skill: 'LISTENING',
      completed: 0,
      required: 2,
      coverageRatio: 0,
      missingSubskills: ['main_idea', 'detail_scanning'],
      dimensions: [
        {
          skill: 'LISTENING',
          subskill: 'main_idea',
          completed: false,
          evidenceRefs: [],
          sourceKinds: [],
          itemCodes: ['L-MAIN'],
        },
        {
          skill: 'LISTENING',
          subskill: 'detail_scanning',
          completed: false,
          evidenceRefs: [],
          sourceKinds: [],
          itemCodes: ['L-DETAIL'],
        },
      ],
      invalidSamples: [INVALID_SAMPLE],
    },
    READING: {
      skill: 'READING',
      completed: 1,
      required: 2,
      coverageRatio: 0.5,
      missingSubskills: ['inference'],
      dimensions: [
        {
          skill: 'READING',
          subskill: 'detail_scanning',
          completed: true,
          evidenceRefs: ['ev-reading-1'],
          sourceKinds: ['客观题', '技能复测'],
          itemCodes: ['R-DETAIL'],
        },
        {
          skill: 'READING',
          subskill: 'inference',
          completed: false,
          evidenceRefs: [],
          sourceKinds: [],
          itemCodes: ['R-INFER'],
        },
      ],
      invalidSamples: [],
    },
    SPEAKING: {
      skill: 'SPEAKING',
      completed: 0,
      required: 0,
      coverageRatio: null,
      missingSubskills: [],
      dimensions: [],
      invalidSamples: [],
    },
    WRITING: {
      skill: 'WRITING',
      completed: 2,
      required: 2,
      coverageRatio: 1,
      missingSubskills: [],
      dimensions: [
        {
          skill: 'WRITING',
          subskill: 'task_response',
          completed: true,
          evidenceRefs: ['ev-writing-1'],
          sourceKinds: ['开放题'],
          itemCodes: ['W-TASK'],
        },
        {
          skill: 'WRITING',
          subskill: 'cohesion',
          completed: true,
          evidenceRefs: ['ev-writing-2'],
          sourceKinds: ['技能复测'],
          itemCodes: ['W-COHESION'],
        },
      ],
      invalidSamples: [],
    },
  },
  invalidSamples: [INVALID_SAMPLE],
};

function view(overrides: Partial<ReadinessViewDto> = {}): ReadinessViewDto {
  return {
    stage: {
      id: 'stage-1',
      code: 'S2_A2_B1',
      nameZh: 'A2→B1 阶段',
      status: 'ACTIVE',
      startDate: '2026-11-10',
    },
    latestReview: {
      id: 'review-1',
      outcome: READY_OUTCOME,
      ruleVersion: 'v2.7.0',
      createdAt: '2026-11-24T09:00:00.000Z',
      userConfirmed: false,
      confirmedAt: null,
      confirmedBy: null,
      note: null,
      criteria: DIMENSIONS,
      snapshot: SNAPSHOT,
      evidenceRefs: ['ev-1', 'ev-2'],
      unmet: [],
    },
    gate: null,
    evidenceCount: 12,
    notConsidered: [
      { label: '学习天数', value: '6 天', note: '不参与判定' },
      { label: '完成率', value: '82%（近 7 天，按时长加权）', note: '不参与判定' },
      { label: '单次 AI 分数', value: '当前没有 AI 评分记录', note: '不参与判定' },
    ],
    ...overrides,
  };
}

const STAGES = [{ code: 'S3_B1_IELTS', label: 'B1→IELTS 阶段（S3_B1_IELTS）' }];

describe('T13 渲染：/planner/readiness', () => {
  it('⑦ 五维表格 + 三态（✓ 通过 / ✗ 未通过 / — 数据不足）', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody view={view()} asOfDate="2026-11-25" stages={STAGES} />,
    );
    expect(html).toContain('data-testid="readiness-dimensions"');
    expect(html).toContain('✓ 通过');
    expect(html).toContain('✗ 未通过');
    expect(html).toContain('— 数据不足');
    expect(html).toContain('data-status="PASS"');
    expect(html).toContain('data-status="FAIL"');
    expect(html).toContain('data-status="INSUFFICIENT"');
  });

  it('⑧ 「不参与判定的指标」反例区显示当前值', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody view={view()} asOfDate="2026-11-25" stages={STAGES} />,
    );
    expect(html).toContain('data-testid="not-considered"');
    expect(html).toContain('学习天数');
    expect(html).toContain('6 天');
    expect(html).toContain('82%（近 7 天，按时长加权）');
    expect(html).toContain('当前没有 AI 评分记录');
    expect(html).toContain('不参与判定');
  });

  it('⑨ 任一维读取失败 → 整体结论降级为 Need more evidence', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody
        view={view({
          latestReview: {
            ...view().latestReview!,
            outcome: READY_OUTCOME,
            criteria: [...DIMENSIONS.slice(0, 4), dimension('REVIEW', '复习稳定', 'READ_ERROR')],
          },
        })}
        asOfDate="2026-11-25"
        stages={STAGES}
      />,
    );
    expect(html).toContain('Need more evidence');
    expect(html).not.toContain('Ready for review');
    expect(html).toContain('存在维度读取失败');
  });

  it('⑩ 切换表单必须有确认人 + 备注（原因必填）', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody view={view()} asOfDate="2026-11-25" stages={STAGES} />,
    );
    expect(html).toContain('data-testid="stage-switch-form"');
    expect(html).toContain('id="confirmed-by"');
    expect(html).toContain('id="switch-reason"');
    expect(html).toContain('id="switch-note"');
    expect(html).toContain('确认人');
    expect(html).toContain('备注（可选）');
  });

  it('⑪ 展示 computedAt、快照 ID、规则版本与蓝图版本', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody view={view()} asOfDate="2026-11-25" stages={STAGES} />,
    );
    expect(html).toContain('data-testid="readiness-snapshot"');
    expect(html).toContain('2026-11-24T09:00:00.123Z');
    expect(html).toContain('snapshot-readiness-1');
    expect(html).toContain('v2.7.1-readiness-1');
    expect(html).toContain('DIAGNOSTIC_BLUEPRINT · 2026.11');
    expect(html).toContain('A2_B1 · blueprint-1');
  });

  it('⑫ 展示技能分子/分母、必测清单、缺失、Evidence IDs 与来源分类', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody view={view()} asOfDate="2026-11-25" stages={STAGES} />,
    );
    expect(html).toContain('data-testid="skill-coverage-LISTENING"');
    expect(html).toContain('0/2 · 0%');
    expect(html).toContain('1/2 · 50%');
    expect(html).toContain('2/2 · 100%');
    expect(html).toContain('缺失子维度：main_idea、detail_scanning');
    expect(html).toContain('必测清单');
    expect(html).toContain('L-MAIN');
    expect(html).toContain('R-INFER');
    expect(html).toContain('Evidence IDs：ev-reading-1');
    expect(html).toContain('来源分类：客观题、技能复测');
  });

  it('⑬ null 覆盖率显示未知（未测），0 覆盖率仍显示 0%', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody view={view()} asOfDate="2026-11-25" stages={STAGES} />,
    );
    expect(html).toContain('data-testid="skill-coverage-SPEAKING"');
    expect(html).toContain('0/0 · 未知（未测）');
    expect(html).toContain('0/2 · 0%');
    expect(html).not.toContain('null%');
  });

  it('⑭ 展示无效样本原因与每维补测建议', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody view={view()} asOfDate="2026-11-25" stages={STAGES} />,
    );
    expect(html).toContain('无效样本与原因');
    expect(html).toContain('attempt-invalid-1 · ATTEMPT · LISTENING / main_idea：未评分');
    expect(html).toContain('证据覆盖的补测建议');
    expect(html).toContain('迁移表现的补测建议');
  });

  it('⑮ 历史评审没有快照/建议时明确标记，不现场回算', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody
        view={view({
          latestReview: {
            ...view().latestReview!,
            criteria: DIMENSIONS.map((row) => ({ ...row, suggestion: null })),
            snapshot: null,
          },
        })}
        asOfDate="2026-11-25"
        stages={STAGES}
      />,
    );
    expect(html).toContain('data-testid="readiness-snapshot-missing"');
    expect(html).toContain('历史评审未记录就绪快照，不回算历史覆盖率');
    expect(html).toContain('历史评审未记录补测建议');
    expect(html).not.toContain('data-testid="skill-coverage-');
  });

  it('⑯ 非 READY 明确禁用确认切换，不再提供越权确认', () => {
    const html = renderToStaticMarkup(
      <ReadinessBody
        view={view({
          latestReview: {
            ...view().latestReview!,
            outcome: 'CONTINUE_CURRENT',
          },
        })}
        asOfDate="2026-11-25"
        stages={STAGES}
      />,
    );
    expect(html).toContain('当前结论未就绪，已禁用确认切换');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认进入下一阶段<\/button>/);
    expect(html).not.toContain('User-approved transition');
    expect(html).not.toContain('越权确认');
  });
});