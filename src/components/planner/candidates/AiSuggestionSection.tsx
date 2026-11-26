/**
 * AI 建议区：**永远渲染**。
 *
 * AI 关闭时这里显示「AI 未参与本次排序」，而不是整块消失 ——
 * 消失会让人误以为「AI 参与了但没什么可说的」，两种状态的界面必须不同。
 *
 * AI 建议只为候选池**补充条目**，排序仍由规则评分决定（AI 不能改序）。
 */

import { Card } from '@/components/ui/Card';
import type { CandidateRowDto } from '@/lib/queries/planner';

export function AiSuggestionSection({ rows, aiNote }: { rows: CandidateRowDto[]; aiNote: string }) {
  return (
    <Card
      title="AI 建议"
      description="AI 只补充候选，不参与排序；被采纳与否由调度器按规则判定"
    >
      <p className="mb-2 text-xs text-ink">{aiNote}</p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-inkMuted">本快照没有 AI 建议的候选。</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.id} className="py-1.5 text-xs">
              <span className="text-ink">{row.title}</span>
              <span className="ml-2 text-[11px] text-inkMuted">
                {row.sourceLabel} · {row.decision?.eligibility ?? '未评分'}
                {row.decision ? ` · 终判 ${row.decision.priority}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}