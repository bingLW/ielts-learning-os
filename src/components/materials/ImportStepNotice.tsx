'use client';

/**
 * 导入向导第 3 步：确认限制与告知。
 *
 * 这一屏是产品承诺的落点（PRD A-01 / A-05）：
 * - 明确列出所有资源上限（数字来自服务端 DTO，前端不硬编码）；
 * - 「我确认有权使用」必须**用户主动勾选**，代码里没有任何预设勾选；
 * - 来源受限时给出常驻警示，而不是提交后才提示。
 */

import { FormField } from '@/components/ui/FormField';
import type { ImportContextDto } from '@/lib/queries/materials';

export function ImportStepNotice({
  context,
  rightsConfirmed,
  restricted,
  error,
  onRightsChange,
}: {
  context: ImportContextDto;
  rightsConfirmed: boolean;
  restricted: boolean;
  error?: string;
  onRightsChange: (checked: boolean) => void;
}) {
  const limits = [
    `单文件 ≤ ${Math.round(context.limits.maxFileBytes / 1024 / 1024)} MB`,
    `PDF ≤ ${context.limits.maxPdfPages} 页`,
    `单材料 ≤ ${context.limits.maxChunks} 个分块（超出只处理前 800）`,
    `粘贴摘录 ≤ ${context.limits.maxPastedChars.toLocaleString()} 字符`,
    `单材料 AI 调用 ≤ ${context.limits.maxAiCalls} 次`,
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-line bg-surfaceAlt p-2.5">
        <p className="text-xs font-semibold text-ink">本期限制</p>
        <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px] text-inkMuted">
          {limits.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <div className="rounded-md border border-line bg-surface p-2.5">
        <p className="text-xs font-semibold text-ink">系统会怎么处理这份材料</p>
        <ol className="mt-1 list-inside list-decimal space-y-0.5 text-[11px] text-inkMuted">
          <li>校验文件真实格式（按文件头判断，改扩展名无效）</li>
          <li>提取正文并分块，原文保存为不可篡改的基线</li>
          <li>AI 只基于原文片段产出摘要、词汇与练习，并标注来源位置</li>
          <li>所有 AI 产出先进入「待你审核」，未经你确认不会影响学习计划</li>
        </ol>
      </div>

      {restricted && (
        <div className="rounded-md border border-egRed/40 bg-egRed/10 p-2.5 text-[11px] leading-relaxed text-egRed">
          {context.unknownSourceWarning}
        </div>
      )}

      <FormField label="权利确认" required hint={context.rightsNotice} error={error}>
        <label className="flex items-start gap-2 rounded-md border border-line bg-surface p-2.5 text-xs text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={rightsConfirmed}
            onChange={(event) => onRightsChange(event.target.checked)}
          />
          <span>
            我确认对这份材料有使用权限，且不会用它生成对外发布的内容。
            <span className="mt-0.5 block text-[11px] text-inkMuted">
              系统不代你判断版权，导入不等于获得授权。
            </span>
          </span>
        </label>
      </FormField>
    </div>
  );
}
