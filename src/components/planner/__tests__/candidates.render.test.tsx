import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ExcludedReasonsDto, CandidateQueueDto } from '@/lib/queries/planner';
import { FACTOR_LABEL_ZH } from '@/lib/domain/taskPriority';
import { CandidateTable } from '../candidates/CandidateTable';
import { CandidateQueueBody } from '../candidates/CandidateQueueBody';
import { candidateRow } from './fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

vi.mock('@/lib/actions/planner', () => ({
  promoteCandidateAction: vi.fn(async () => ({ ok: true, data: { candidateId: 'cand-1', priority: 'P1' } })),
}));

function queue(overrides: Partial<CandidateQueueDto> = {}): CandidateQueueDto {
  return {
    snapshotId: 'snap-1',
    total: 1,
    rows: [candidateRow()],
    aiNote: 'AI 未参与本次排序',
    ...overrides,
  };
}

function excluded(): ExcludedReasonsDto {
  return {
    snapshotId: 'snap-1',
    total: 0,
    groups: [
      { code: 'PREREQUISITE', label: '前置条件未满足', items: [] },
      { code: 'BUDGET', label: '超出当日预算', items: [] },
      { code: 'DUPLICATE', label: '与更优先的候选重复', items: [] },
      { code: 'AI_REJECTED', label: 'AI 建议被调度器拒绝', items: [] },
    ],
  };
}

function renderQueue(weightsInvalid: boolean) {
  return renderToStaticMarkup(
    <CandidateQueueBody
      queue={queue()}
      excluded={excluded()}
      filter={{}}
      weightsInvalid={weightsInvalid}
      weightsError={weightsInvalid ? '七项权重之和必须等于 1（|Σ−1| < 1e-9）' : null}
      filterError={null}
    />,
  );
}

describe('T11 渲染：/planner/candidates', () => {
  it('⑦ 展开决策轨迹 → 七个因子 + 权重 + 终判 P 级', () => {
    const html = renderToStaticMarkup(<CandidateTable rows={[candidateRow()]} />);
    expect(html).toContain('<details');
    expect(html).toContain('展开决策轨迹');
    for (const label of Object.values(FACTOR_LABEL_ZH)) {
      expect(html).toContain(label);
    }
    expect(html).toContain('权重版本 w1');
    expect(html).toContain('加权总分');
    expect(html).toContain('终判');
    expect(html).toContain('P2（P2）');
  });

  it('⑧ 权重非法 → 顶部红条 + 生成入口禁用（不静默回落默认权重）', () => {
    const invalid = renderQueue(true);
    expect(invalid).toContain('data-testid="weights-invalid"');
    expect(invalid).toContain('权重配置不合法');
    expect(invalid).toContain('不会偷偷用默认权重');
    expect(invalid).toContain('aria-disabled="true"');
    expect(invalid).not.toContain('href="/planner/build"');

    const valid = renderQueue(false);
    expect(valid).not.toContain('data-testid="weights-invalid"');
    expect(valid).toContain('href="/planner/build"');
  });

  it('⑨ AI 建议区始终存在；AI 未参与时显式说明而不是隐藏', () => {
    const html = renderQueue(false);
    expect(html).toContain('AI 建议');
    expect(html).toContain('AI 未参与本次排序');
  });
});