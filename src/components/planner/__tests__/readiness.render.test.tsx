import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReadinessBody } from '../readiness/ReadinessBody';
import { READY_OUTCOME } from '@/lib/domain/readiness';
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
  };
}

const DIMENSIONS: ReadinessDimensionRowDto[] = [
  dimension('COVERAGE', '证据覆盖', 'PASS'),
  dimension('TRANSFER', '迁移表现', 'FAIL'),
  dimension('RETEST', '复测保持', 'INSUFFICIENT'),
  dimension('INDEPENDENCE', '独立完成', 'PASS'),
  dimension('REVIEW', '复习稳定', 'PASS'),
];

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
});