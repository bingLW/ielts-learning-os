/**
 * 来源徽章（三态不可合并，`41` G-12）。
 *
 * `RULE` / `AI` / `USER_EDIT` 是三种不同的责任归属：规则排入 = 评分器决定；
 * AI = 只润色措辞或从池中挑选；USER_EDIT = 用户手动改过。合并成「系统生成」
 * 会让用户无法追问「是谁改的」，也无法在 AI 关闭时正确显示。
 */

export type PlannerOrigin = 'RULE' | 'AI' | 'USER_EDIT';

const CLASS_BY_ORIGIN: Record<PlannerOrigin, string> = {
  RULE: 'border-slate-300 bg-slate-50 text-slate-700',
  AI: 'border-violet-300 bg-violet-50 text-violet-700',
  USER_EDIT: 'border-amber-300 bg-amber-50 text-amber-800',
};

const LABEL_BY_ORIGIN: Record<PlannerOrigin, string> = {
  RULE: '规则排入',
  AI: 'AI 建议',
  USER_EDIT: '手动调整',
};

export function OriginBadge({ origin }: { origin: PlannerOrigin }) {
  return (
    <span
      title={`origin=${origin}`}
      className={[
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        CLASS_BY_ORIGIN[origin],
      ].join(' ')}
    >
      {LABEL_BY_ORIGIN[origin]}
    </span>
  );
}