'use client';

/**
 * 轻提示（保存成功 / 操作失败）。
 *
 * 设计取舍：不做全局 Provider，而是「谁操作谁持有状态」——页面内用一个
 * `useToastState()`，把 `<Toast />` 挂在页面根部即可。这样不同页面的提示互不串台，
 * 也不需要额外的 context 层级。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastState {
  message: string;
  tone: ToastTone;
}

/** 轻提示状态钩子。 */
export function useToastState(autoHideMs = 3200) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      clear();
      setToast({ message, tone });
      timer.current = setTimeout(() => setToast(null), autoHideMs);
    },
    [autoHideMs, clear],
  );

  const dismiss = useCallback(() => {
    clear();
    setToast(null);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return { toast, show, dismiss };
}

const TONE_CLASS: Record<ToastTone, string> = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  error: 'border-red-300 bg-red-50 text-red-800',
  info: 'border-blue-300 bg-blue-50 text-blue-800',
};

const TONE_ICON = {
  success: 'check',
  error: 'alert',
  info: 'circle',
} as const;

export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 sm:bottom-6"
    >
      <div
        className={[
          'flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs shadow-lg',
          TONE_CLASS[toast.tone],
        ].join(' ')}
      >
        <Icon name={TONE_ICON[toast.tone]} size={14} />
        <span>{toast.message}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭提示"
          className="ml-1 opacity-70 hover:opacity-100"
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  );
}
