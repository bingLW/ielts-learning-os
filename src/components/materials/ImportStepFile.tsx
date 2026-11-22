'use client';

/**
 * 导入向导第 1 步：选择导入方式（文件 / 粘贴）并填标题。
 *
 * 「文件」与「粘贴」二选一由服务端强制（`finalizeMaterialUpload` 会拒），
 * 这里只做体验层互斥，避免用户填完才发现冲突。
 */

import { FormField, inputClass, textareaClass } from '@/components/ui/FormField';
import type { ImportContextDto } from '@/lib/queries/materials';
import type { ImportDraft, ImportMode } from './importTypes';

export function ImportStepFile({
  draft,
  context,
  errors,
  onMode,
  onFile,
  onPastedText,
  onTitle,
}: {
  draft: ImportDraft;
  context: ImportContextDto;
  errors: Record<string, string>;
  onMode: (mode: ImportMode) => void;
  onFile: (file: File | null) => void;
  onPastedText: (text: string) => void;
  onTitle: (title: string) => void;
}) {
  const modeButton = (mode: ImportMode, label: string, hint: string) => {
    const active = draft.mode === mode;
    return (
      <button
        type="button"
        onClick={() => onMode(mode)}
        aria-pressed={active}
        className={[
          'flex-1 rounded-md border px-3 py-2 text-left text-xs transition-colors',
          active
            ? 'border-brand bg-brand/10 text-brand'
            : 'border-line bg-surface text-inkMuted hover:bg-surfaceAlt',
        ].join(' ')}
      >
        <span className="block font-semibold">{label}</span>
        <span className="mt-0.5 block text-[11px]">{hint}</span>
      </button>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {modeButton('file', '上传文件', 'TXT / Markdown / HTML / PDF / Word')}
        {modeButton('paste', '粘贴一段文本', `最多 ${context.limits.maxPastedChars.toLocaleString()} 字符`)}
      </div>

      {draft.mode === 'file' ? (
        <FormField
          label="选择文件"
          required
          error={errors.file}
          hint={`支持 ${context.accept}；单个文件 ≤ ${Math.round(context.limits.maxFileBytes / 1024 / 1024)} MB，PDF ≤ ${context.limits.maxPdfPages} 页`}
        >
          <input
            type="file"
            accept={context.accept}
            className={`${inputClass} text-xs file:mr-2 file:rounded file:border file:border-line file:bg-surfaceAlt file:px-2 file:py-1 file:text-xs`}
            onChange={(event) => onFile(event.target.files?.[0] ?? null)}
          />
        </FormField>
      ) : (
        <FormField
          label="粘贴正文"
          required
          error={errors.text}
          hint="适合网页摘录、笔记片段。粘贴内容同样按「不可篡改原文」保存。"
        >
          <textarea
            className={`${textareaClass} min-h-[160px] font-mono text-xs`}
            value={draft.pastedText}
            onChange={(event) => onPastedText(event.target.value)}
            placeholder="Paste your English text here…"
          />
        </FormField>
      )}

      <FormField label="标题" hint="留空则用文件名（粘贴内容取正文开头）">
        <input
          className={inputClass}
          value={draft.title}
          onChange={(event) => onTitle(event.target.value)}
          maxLength={200}
          placeholder="例如：The Economist — Why sleep matters"
        />
      </FormField>

      {draft.file && (
        <p className="text-[11px] text-inkMuted">
          已选：{draft.file.name} · {(draft.file.size / 1024).toFixed(1)} KB
        </p>
      )}
    </div>
  );
}
