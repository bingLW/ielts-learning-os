'use client';

/**
 * 建议预算与技能配比的可采纳列表（PRD §4.8⑤）。
 *
 * 每条建议都带「变更原因」；只有点击「接受」才写入**下一周** WeeklyTarget
 * （`source=SUGGESTION_ACCEPTED`）。不接受 = 不写入，不会自动改计划。
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { acceptWeeklySuggestionAction } from '@/lib/actions/planner';
import type { WeeklyDeltaSuggestion } from '@/lib/domain/weeklyDelta';

const KIND_LABEL: Record<WeeklyDeltaSuggestion['kind'], string> = {
  ADJUST_TIME: '调整时间',
  ADJUST_FOCUS: '调整重点',
  KEEP: '保持不变',
};

export function SuggestionAcceptList({
  suggestions,
  isoYear,
  isoWeek,
}: {
  suggestions: WeeklyDeltaSuggestion[];
  isoYear: number;
  isoWeek: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [accepted, setAccepted] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  if (suggestions.length === 0) {
    return (
      <p data-testid="suggestion-empty" className="text-[11px] text-inkMuted">
        本次没有调整建议：要么样本不足，要么波动未达阈值。计划保持原样，直到你自己决定修改。
      </p>
    );
  }

  const accept = (index: number) => {
    setError(null);
    const suggestion = suggestions[index]!;
    startTransition(async () => {
      const result = await acceptWeeklySuggestionAction({
        isoYear,
        isoWeek,
        suggestion: { kind: suggestion.kind, note: suggestion.note },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAccepted((current) => ({
        ...current,
        [index]: `已写入下周（${result.data.weekStart}）目标：${result.data.targetMinutes} 分钟`,
      }));
      router.refresh();
    });
  };

  return (
    <div data-testid="suggestion-list" className="space-y-1.5">
      {suggestions.map((suggestion, index) => (
        <div
          key={`${suggestion.kind}-${index}`}
          className="rounded border border-line bg-white px-2.5 py-1.5"
        >
          <div className="flex flex-wrap items-start justify-between gap-1.5">
            <div>
              <p className="text-[11px] font-medium text-ink">
                {KIND_LABEL[suggestion.kind]}：{suggestion.note}
              </p>
              <p className="mt-0.5 text-[11px] text-inkMuted">变更原因：{suggestion.basis}</p>
            </div>
            <button
              type="button"
              disabled={pending || Boolean(accepted[index])}
              onClick={() => accept(index)}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-surfaceAlt disabled:opacity-50"
            >
              {accepted[index] ? '已接受' : '接受'}
            </button>
          </div>
          {accepted[index] && (
            <p className="mt-0.5 text-[11px] text-green-700">{accepted[index]}</p>
          )}
        </div>
      ))}
      <p className="text-[11px] text-inkMuted">
        不接受 = 不写入任何数据；系统不会因为「你没点拒绝」就自动采纳。
      </p>
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </div>
  );
}