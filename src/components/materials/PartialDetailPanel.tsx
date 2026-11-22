'use client';

/**
 * 部分完成明细面板（US-8 / A-06）。
 *
 * 三件事必须说清楚，否则用户会以为「材料坏了」：
 * 1. 哪些页/元素没有参与分析（页码 + 丢弃计数）；
 * 2. 已解析的部分**仍然可用**（可以去阅读/分析）；
 * 3. 想完整利用原文时的下一步动作（换更清晰的 PDF / 补齐页）。
 */

import type { MaterialStatusDto } from '@/lib/queries/materials';

const ELEMENT_LABELS_ZH: Record<string, string> = {
  droppedImages: '图片',
  droppedFootnotes: '脚注',
  droppedComments: '批注',
  droppedTextboxes: '文本框',
  image: '图片',
  link: '链接',
  table: '表格',
  inlineHtml: '内嵌 HTML',
  frontMatter: '前置元信息',
  codeFence: '代码围栏',
  hr: '分隔线',
  comment: '注释',
  doctype: 'DOCTYPE',
  processingInstruction: '处理指令',
  hrCount: '分隔线',
  blockLimit: '超出块上限的内容',
  blockTruncated: '被截断的长块',
  noTextLayerPages: '无文本层页',
};

function labelOf(key: string): string {
  if (ELEMENT_LABELS_ZH[key]) return ELEMENT_LABELS_ZH[key];
  if (key.startsWith('tag:')) return `<${key.slice(4)}> 标签`;
  return key;
}

export function PartialDetailPanel({ status }: { status: MaterialStatusDto }) {
  const partial = status.partial;
  if (!partial) return null;

  const dropped = Object.entries(partial.droppedElements).filter(([, count]) => count > 0);
  const hasPages = partial.pages.length > 0;

  if (!hasPages && dropped.length === 0 && !partial.aiCallLimitHit) return null;

  return (
    <div className="rounded-lg border border-egYellow/50 bg-egYellow/10 p-3">
      <p className="text-xs font-semibold text-ink">部分内容未参与分析</p>
      <p className="mt-0.5 text-[11px] text-inkMuted">
        已解析的部分仍然可以正常使用；下面列出被跳过的内容，便于你判断是否需要补充材料。
      </p>

      {hasPages && (
        <p className="mt-2 text-[11px] text-ink">
          <span className="font-medium">无文本层的页：</span>
          第 {partial.pages.join('、')} 页（可能是扫描件或纯图片页）
        </p>
      )}

      {dropped.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {dropped.map(([key, count]) => (
            <li
              key={key}
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-inkMuted"
              title={`${key}：${count}`}
            >
              {labelOf(key)} × {count}
            </li>
          ))}
        </ul>
      )}

      {partial.aiCallLimitHit && (
        <p className="mt-2 text-[11px] text-ink">
          已达到单材料 AI 调用上限，仅分析了前一部分内容（可稍后继续分析剩余部分）。
        </p>
      )}
    </div>
  );
}
