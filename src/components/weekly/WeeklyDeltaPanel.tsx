/**
 * 周复盘新增区块：本周真正改善的 / 仍未解决的 / 需要进一步诊断的（PRD §4.8 ①②③）。
 *
 * 结论全部来自 `buildWeeklyDelta()`（服务端算好），这里只渲染，不重算。
 * 空数组时也要给出「为什么空」的说明，避免被误读成「没检查」。
 */

import { Card } from '@/components/ui/Card';
import type { ReactNode } from 'react';
import type {
  WeeklyDeltaCategory,
  WeeklyDeltaItem,
  WeeklyDeltaResult,
} from '@/lib/domain/weeklyDelta';
import { SuggestionAcceptList } from './SuggestionAcceptList';
import { ThresholdNote } from './ThresholdNote';

const SECTION_META: {
  category: WeeklyDeltaCategory;
  field: 'improved' | 'unresolved' | 'needsDiagnosis';
  title: string;
  empty: string;
  tone: string;
}[] = [
  {
    category: 'IMPROVED',
    field: 'improved',
    title: '本周真正改善的',
    empty: '本周没有达到阈值（15%）且样本足够的改善项。',
    tone: 'border-green-200 bg-green-50',
  },
  {
    category: 'UNRESOLVED',
    field: 'unresolved',
    title: '仍未解决的',
    empty: '本周没有未改善的已比较维度。',
    tone: 'border-amber-200 bg-amber-50',
  },
  {
    category: 'NEEDS_DIAGNOSIS',
    field: 'needsDiagnosis',
    title: '需要进一步诊断的',
    empty: '本周没有新增待确认维度。',
    tone: 'border-sky-200 bg-sky-50',
  },
];

function ItemList({ items }: { items: WeeklyDeltaItem[] }) {
  return (
    <ul className="mt-1 space-y-1">
      {items.map((item) => (
        <li key={`${item.metric}-${item.detail}`} className="text-[11px] text-ink">
          <span className="font-medium">{item.label}</span>
          <span className="text-inkMuted">：{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function WeeklyDeltaPanel({
  delta,
  isoYear,
  isoWeek,
  themeSlot,
}: {
  delta: WeeklyDeltaResult;
  isoYear: number;
  isoWeek: number;
  /** ④ 下周 1 个主要突破目标；由页面上层注入，保持面板只负责 ①②③⑤⑥。 */
  themeSlot?: ReactNode;
}) {
  return (
    <Card
      title="本周变化（对比上周）"
      description="有证据支持的改善才叫改善；样本不足或波动未达阈值时不下结论"
    >
      <p data-testid="weekly-delta-headline" className="text-[11px] font-medium text-ink">
        {delta.headline}
      </p>

      {delta.sampleInsufficient ? (
        <div
          data-testid="weekly-delta-insufficient"
          className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900"
        >
          样本不足，建议仅记录，不调整计划；本周也不会生成任何调整建议。
        </div>
      ) : (
        <div className="mt-1.5 grid gap-1.5 md:grid-cols-3">
          {SECTION_META.map((section) => {
            const items = delta[section.field];
            return (
              <div
                key={section.category}
                data-testid={`weekly-section-${section.category}`}
                className={`rounded border px-2.5 py-1.5 ${section.tone}`}
              >
                <p className="text-[11px] font-semibold text-ink">{section.title}</p>
                {items.length > 0 ? (
                  <ItemList items={items} />
                ) : (
                  <p className="mt-1 text-[11px] text-inkMuted">{section.empty}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {themeSlot && <div className="mt-2">{themeSlot}</div>}

      <div className="mt-2 space-y-1.5">
        <p className="text-[11px] font-medium text-ink">建议预算与技能配比</p>
        <SuggestionAcceptList
          suggestions={delta.suggestions}
          isoYear={isoYear}
          isoWeek={isoWeek}
        />
      </div>

      <div className="mt-2">
        <ThresholdNote delta={delta} />
      </div>
    </Card>
  );
}