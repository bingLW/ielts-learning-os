/**
 * readiness 结论卡（PRD §4.9①）。
 *
 * 结论来自已落库的评审快照；文案与「读取失败 → Need more evidence」的不变量
 * 都定义在 `domain/readiness.ts`（G-7：组件不持有结论字面量，也不重算证据）。
 */

import { Card } from '@/components/ui/Card';
import {
  effectiveReadinessOutcome,
  readinessOutcomeHeadline,
  readinessOutcomeLabel,
} from '@/lib/domain/readiness';
import type { ReadinessDimensionRowDto } from '@/lib/queries/planner';

/** 视觉色调按 label 取（label 由 domain 唯一产出，组件不再重复结论标识）。 */
const TONE_BY_LABEL: Record<string, string> = {
  'Ready for review': 'border-green-300 bg-green-50 text-green-900',
  'Continue current stage': 'border-line bg-surfaceAlt text-ink',
  'Need targeted practice': 'border-amber-300 bg-amber-50 text-amber-900',
  'Need more evidence': 'border-sky-300 bg-sky-50 text-sky-900',
  'User-approved transition': 'border-purple-300 bg-purple-50 text-purple-900',
};

export function ReadinessConclusion({
  outcome,
  dimensions,
  userConfirmed,
  confirmedBy,
  confirmedAt,
}: {
  outcome: string | null;
  dimensions: ReadinessDimensionRowDto[];
  userConfirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
}) {
  const effective = effectiveReadinessOutcome(outcome, dimensions);
  if (!effective) {
    return (
      <Card title="阶段结论" description="系统只建议，不自动切换阶段">
        <p className="text-[11px] text-inkMuted">
          还没有 readiness 评审。先点「生成/刷新评审」按当前证据给出一版结论，再决定是否切换。
        </p>
      </Card>
    );
  }

  const label = readinessOutcomeLabel(effective);
  const zh = readinessOutcomeHeadline(effective) ?? '未知结论（规则版本可能已变更）。';
  const tone = TONE_BY_LABEL[label] ?? 'border-line bg-surfaceAlt text-ink';
  const readError = dimensions.some((row) => row.status === 'READ_ERROR');

  return (
    <Card title="阶段结论" description="系统只建议，不自动切换阶段；确认动作记录确认人与理由">
      <div data-testid="readiness-conclusion" className={`rounded-md border px-3 py-2 ${tone}`}>
        <p className="text-sm font-semibold">{label}</p>
        <p className="mt-0.5 text-[11px]">{zh}</p>
        {readError && effective !== outcome && (
          <p className="mt-1 text-[11px] font-medium">
            存在维度读取失败：按规则整体结论降级为 {readinessOutcomeLabel(effective)}
            （不会在缺数据时给 Ready）。
          </p>
        )}
      </div>
      {userConfirmed && (
        <p className="mt-1.5 text-[11px] text-inkMuted">
          已由 {confirmedBy ?? '本人'} 于 {confirmedAt?.slice(0, 16).replace('T', ' ') ?? '—'} 确认切换。
        </p>
      )}
    </Card>
  );
}