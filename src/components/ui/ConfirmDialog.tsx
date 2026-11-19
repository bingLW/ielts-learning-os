'use client';

/**
 * 破坏性操作二次确认对话框。
 *
 * 用原生 `<dialog>` 的替代实现（受控 div + 遮罩）：
 * - 有 `role="dialog"` + `aria-modal` + 标题关联；
 * - Esc 关闭；
 * - 焦点默认落在「取消」上，避免误触销毁。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <span
            className={[
              'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
              danger ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700',
            ].join(' ')}
          >
            <Icon name="alert" size={15} />
          </span>
          <div className="min-w-0">
            <h2 id="confirm-dialog-title" className="text-sm font-semibold text-ink">
              {title}
            </h2>
            {description && <div className="mt-1 text-xs text-inkMuted">{description}</div>}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className="rounded-md border border-line px-3 py-1.5 text-xs" onClick={onCancel}>
            {cancelLabel}
          </button>
          <Button variant={danger ? 'danger' : 'primary'} size="sm" disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
