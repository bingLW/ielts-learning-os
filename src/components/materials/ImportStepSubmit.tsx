'use client';

/**
 * 导入向导第 4 步：确认与提交。
 *
 * 去重命中（A-04）时**不直接报错**，而是把「打开已有 / 另存为副本」交给用户选：
 * - 打开已有：跳到已有材料的处理页（不产生新记录）；
 * - 另存为副本：服务端从已有材料的原文复制一份（`duplicateOfId` 指向它）。
 */

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { ImportContextDto } from '@/lib/queries/materials';
import type { ImportDraft } from './importTypes';

export interface DuplicatePrompt {
  materialId: string;
  contentHash: string;
}

function summaryRows(
  draft: ImportDraft,
  context: ImportContextDto,
): Array<{ label: string; value: string }> {
  const sourceLabel =
    context.sourceTypes.find((item) => item.value === draft.source.sourceType)?.label ??
    draft.source.sourceType;
  const size = draft.file ? `${draft.file.name}（${(draft.file.size / 1024).toFixed(1)} KB）` : '粘贴文本';
  return [
    { label: '导入方式', value: draft.mode === 'file' ? '上传文件' : '粘贴文本' },
    { label: '内容', value: size },
    { label: '标题', value: draft.title.trim() || '（自动取文件名/正文开头）' },
    { label: '来源', value: sourceLabel },
    { label: '权利确认', value: draft.source.rightsConfirmed ? '已确认' : '未确认' },
  ];
}

export function ImportStepSubmit({
  draft,
  context,
  error,
  busy,
  duplicate,
  onSubmit,
  onOpenExisting,
  onKeepCopy,
  onBack,
}: {
  draft: ImportDraft;
  context: ImportContextDto;
  error: string | null;
  busy: boolean;
  duplicate: DuplicatePrompt | null;
  onSubmit: () => void;
  onOpenExisting: () => void;
  onKeepCopy: () => void;
  onBack: () => void;
}) {
  if (duplicate) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-egYellow/50 bg-egYellow/10 p-3">
          <p className="text-xs font-semibold text-ink">这份内容之前已经导入过</p>
          <p className="mt-1 text-[11px] leading-relaxed text-inkMuted">
            系统按内容哈希查到了完全相同的材料。你可以直接打开它继续用，
            也可以另存一份副本（副本会重新解析，两边的审核与练习互不影响）。
          </p>
          <p className="mt-1 font-mono text-[10px] text-inkMuted">hash: {duplicate.contentHash.slice(0, 16)}…</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="primary" size="sm" onClick={onOpenExisting} disabled={busy}>
            <Icon name="bookOpen" size={13} />
            打开已有材料
          </Button>
          <Button variant="secondary" size="sm" onClick={onKeepCopy} disabled={busy}>
            <Icon name="plus" size={13} />
            另存为副本
          </Button>
          <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
            返回修改
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <dl className="divide-y divide-line rounded-md border border-line bg-surface">
        {summaryRows(draft, context).map((row) => (
          <div key={row.label} className="flex items-baseline gap-3 px-2.5 py-1.5">
            <dt className="w-20 shrink-0 text-[11px] text-inkMuted">{row.label}</dt>
            <dd className="min-w-0 flex-1 truncate text-xs text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>

      {error && (
        <p role="alert" className="rounded-md border border-egRed/40 bg-egRed/10 p-2 text-xs text-egRed">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="primary" size="sm" onClick={onSubmit} disabled={busy}>
          <Icon name="check" size={13} />
          {busy ? '正在导入…' : '开始导入'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
          上一步
        </Button>
        <span className="text-[11px] text-inkMuted">
          导入后会立刻开始校验与解析，通常几秒完成（大 PDF 可能需要多等几秒）。
        </span>
      </div>
    </div>
  );
}
