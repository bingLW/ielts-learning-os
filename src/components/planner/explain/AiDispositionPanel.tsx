/**
 * AI 处置区：**永远渲染**，AI 未参与时显示说明而不是整块隐藏。
 *
 * 隐藏会让用户误以为「这次任务没有 AI 相关动作」，而实际是「AI 关闭 / 回落规则」；
 * 两种情况都必须可被追问。被拒绝的 AI 建议也在这里逐条列出理由。
 */

import { Card } from '@/components/ui/Card';
import type { PlanExplanationDto } from '@/lib/queries/planner';

export function AiDispositionPanel({
  aiNote,
  rejected,
}: {
  aiNote: string;
  rejected: PlanExplanationDto['rejectedAiSuggestions'];
}) {
  const aiInvolved = aiNote.includes('AI 参与') || aiNote.includes('AI 建议');
  return (
    <Card title="AI 处置" description="AI 只做建议与措辞；优先级与分钟始终由规则校验后写入">
      <p data-testid="ai-note" className="text-xs text-ink">
        {aiNote}
      </p>
      <p className="mt-1 text-[11px] text-inkMuted">
        {aiInvolved
          ? 'AI 建议只有在通过规则校验（预算、前置条件、配比）后才会进入计划。'
          : '本次没有调用 AI，全部任务由规则引擎生成；这是正常状态，不是降级故障。'}
      </p>
      <div className="mt-2">
        <p className="text-[11px] font-semibold text-ink">被拒绝的 AI 建议</p>
        {rejected.length === 0 ? (
          <p className="mt-0.5 text-xs text-inkMuted">本次没有 AI 建议被拒绝。</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {rejected.map((row) => (
              <li key={`${row.title}:${row.aiCallLogId ?? row.reason}`} className="text-xs text-ink">
                {row.title}
                <span className="ml-1 text-inkMuted">
                  · {row.reason}
                  {row.aiCallLogId ? `（调用日志 ${row.aiCallLogId.slice(0, 8)}）` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}