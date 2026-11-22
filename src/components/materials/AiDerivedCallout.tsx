/**
 * AI 衍生结论的统一标注（C-11 / E-01）。
 *
 * 产品口径：**任何 AI 生成的内容，旁边必须能一眼看出"这不是原文"**。
 * 所以这里做成一个小徽章而不是散落在各处的字符串，页面只需
 * `<AiDerivedCallout />`，措辞与配色就只有一处来源。
 *
 * 配色只用调色板里的 `egYellow`（警示但不等于错误），与 failed/error 的
 * `egRed` 明确区分：AI 衍生不是错误，是"需要你判断"。
 */

import { Icon } from '@/components/ui/Icon';

export interface AiDerivedCalloutProps {
  /** 主文案，默认「AI 生成」。 */
  label?: string;
  /** 追加一句解释（如「非官方答案」「可能不准确」）。 */
  note?: string;
  className?: string;
}

export function AiDerivedCallout({
  label = 'AI 生成',
  note,
  className,
}: AiDerivedCalloutProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded border border-egYellow/50 bg-egYellow/10',
        'px-1.5 py-0.5 text-[10px] font-medium leading-4 text-ink',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Icon name="bulb" size={10} />
      {label}
      {note && <span className="text-inkMuted">· {note}</span>}
    </span>
  );
}
