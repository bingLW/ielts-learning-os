/**
 * 复测历史表（T23）。
 *
 * 只读组件：没有任何编辑/删除入口 —— 这是 append-only 的 UI 层保障。
 * <768px 转卡片列表，避免横向滚动。
 */

import { formatPercent, formatQuestionRatio } from '@/lib/format';
import type { EgiuReviewRowDto } from '@/lib/types';
import { ColorBadge } from '@/components/ui/ColorBadge';
import { TagBadge } from '@/components/ui/StatusBadge';

export function ReviewTimeline({ reviews }: { reviews: EgiuReviewRowDto[] }) {
  const ordered = [...reviews].reverse();

  return (
    <>
      <div className="hidden md:block">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-inkMuted">
              <th className="py-1.5 pr-2 font-medium">日期</th>
              <th className="py-1.5 pr-2 font-medium">档位</th>
              <th className="py-1.5 pr-2 font-medium">题量 / 正确率</th>
              <th className="py-1.5 pr-2 font-medium">证据</th>
              <th className="py-1.5 pr-2 font-medium">判定</th>
              <th className="py-1.5 font-medium">理由（系统原文）</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((review) => (
              <tr key={review.id} className="border-b border-line align-top">
                <td className="tabular py-1.5 pr-2 text-[11px]">{review.reviewDate}</td>
                <td className="py-1.5 pr-2 text-[11px]">{review.reviewStageLabel}</td>
                <td className="tabular py-1.5 pr-2 text-[11px]">
                  {formatQuestionRatio(review.correctQuestions, review.totalQuestions)}
                  <span className="ml-1 text-inkMuted">{formatPercent(review.accuracy)}</span>
                </td>
                <td className="py-1.5 pr-2 text-[11px] text-inkMuted">
                  {review.coreRuleOk ? '理解规则' : '不理解规则（硬否决）'} /{' '}
                  {review.explainOk ? '能讲清' : '讲不清'} / 造句 {review.sentencesCount}
                </td>
                <td className="py-1.5 pr-2">
                  <ColorBadge color={review.judgedColor} score={review.score} />
                  {/* judge_branch 只用于追溯与审计（PRD §7 E8）：收进折叠区，
                      不把原始枚举值当作结论直接摆给用户看。 */}
                  <details className="mt-0.5 text-[10px] text-inkMuted">
                    <summary className="cursor-pointer select-none">判定路径</summary>
                    <span className="mt-0.5 block">{review.judgeBranchLabel}</span>
                  </details>
                </td>
                <td className="max-w-[300px] py-1.5 text-[11px] text-inkMuted">
                  {review.judgeReason}
                  {review.errorBreakdown && (
                    <div className="mt-0.5 text-[10px]">
                      错因：规则不清 {review.errorBreakdown.ruleUnclear} / 记忆混淆{' '}
                      {review.errorBreakdown.memoryConfusion} / 粗心{' '}
                      {review.errorBreakdown.careless} / 词汇 {review.errorBreakdown.vocab}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {ordered.map((review) => (
          <li key={review.id} className="rounded-md border border-line bg-white p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-ink">
                  {review.reviewDate} · {review.reviewStageLabel}
                </p>
                <p className="text-[11px] text-inkMuted">
                  {formatQuestionRatio(review.correctQuestions, review.totalQuestions)} ·{' '}
                  {formatPercent(review.accuracy)}
                </p>
              </div>
              <ColorBadge color={review.judgedColor} score={review.score} />
            </div>
            <p className="mt-1 text-[11px] text-inkMuted">{review.judgeReason}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              <TagBadge tone="info">{review.explainOk ? '能讲清' : '讲不清'}</TagBadge>
              <TagBadge tone="info">造句 {review.sentencesCount}</TagBadge>
            </div>
            {/* 移动端同样折叠：judge_branch 是审计字段，不是给用户看的结论。 */}
            <details className="mt-1 text-[10px] text-inkMuted">
              <summary className="cursor-pointer select-none">判定路径</summary>
              <span className="mt-0.5 block">{review.judgeBranchLabel}</span>
            </details>
          </li>
        ))}
      </ul>
    </>
  );
}
