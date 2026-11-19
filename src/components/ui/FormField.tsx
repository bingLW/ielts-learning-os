/**
 * 表单字段包装：中文标签 + 必填标记 + 错误文案 + 口径提示。
 *
 * 错误文案来自 Server Action 返回的 `fieldErrors`，因此这里只负责展示，
 * 不做任何校验逻辑（校验一律在 zod schema 里，前后端同一份）。
 */

import type { ReactNode } from 'react';

export interface FormFieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}

export function FormField({
  label,
  htmlFor,
  required = false,
  hint,
  error,
  children,
  className,
}: FormFieldProps) {
  return (
    <div className={['flex flex-col gap-1', className].filter(Boolean).join(' ')}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink">
        {label}
        {required && (
          <span className="ml-0.5 text-red-600" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && <p className="text-[11px] text-inkMuted">{hint}</p>}
      {error && (
        <p role="alert" className="text-[11px] font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/** 统一样式的输入框类名。 */
export const inputClass =
  'w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-sm text-ink placeholder:text-slate-400 disabled:bg-surfaceAlt disabled:text-inkMuted';

/** 统一样式的多行文本框。 */
export const textareaClass = `${inputClass} min-h-[72px] resize-y`;

/** 统一样式的下拉框。 */
export const selectClass = inputClass;
