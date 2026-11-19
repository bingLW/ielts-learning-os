/**
 * Dashboard ⑥ 语法与词汇：EGIU 三色计数（最新判定）+ 红灯未处理数 + 词汇三档分布。
 */

import { MASTERY_LABEL_ZH, MASTERY_LEVELS } from '@/lib/constants';
import { formatPercent } from '@/lib/format';
import type { DashboardDto } from '@/lib/types';
import { ColorLegend } from '@/components/ui/ColorBadge';
import { Card } from '@/components/ui/Card';

export function GrammarVocabCard({ data }: { data: DashboardDto['grammarVocab'] }) {
  const { colors, redUnhandled, vocabTotal, vocabNewThisWeek, mastery } = data;

  return (
    <Card
      title="语法与词汇"
      description="三色按每个单元的最新判定计 1 次；词汇三档不可合并为单一「已掌握」。"
    >
      <div className="mb-2">
        <ColorLegend counts={colors} />
        <p className="mt-1 text-[11px] text-inkMuted">
          未处理红灯 <b className="text-red-700">{redUnhandled}</b> 个
          {redUnhandled > 0 ? ' · 红灯必须重学并复测至黄灯以上' : ' · 无红灯欠账'}
        </p>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-3">
        {MASTERY_LEVELS.map((level) => (
          <div key={level} className="rounded border border-line bg-surfaceAlt px-2 py-1">
            <p className="text-[11px] text-inkMuted">{MASTERY_LABEL_ZH[level]}</p>
            <p className="tabular text-sm font-semibold text-ink">{mastery[level]}</p>
          </div>
        ))}
      </div>

      <p className="mt-2 text-[11px] text-inkMuted">
        词汇累计 <b className="tabular">{vocabTotal}</b> 词 · 本周新增{' '}
        <b className="tabular">{vocabNewThisWeek}</b> 词 · 最近抽测加权正确率{' '}
        <b className="tabular">{formatPercent(mastery.quizAccuracy)}</b>
      </p>
      {vocabTotal === 0 && (
        <p className="mt-1 text-[11px] text-inkMuted">
          还没有词汇数据。词汇模块将在阶段 C 开放录入与抽测。
        </p>
      )}
    </Card>
  );
}
