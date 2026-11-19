/**
 * 按钮样式与组件。
 *
 * 颜色不是唯一信息载体：`danger` 同时带图标与文案，禁用态保留可见边框。
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border-brand bg-brand text-white hover:bg-blue-700 hover:border-blue-700 disabled:hover:bg-brand',
  secondary: 'border-line bg-white text-ink hover:bg-surfaceAlt',
  ghost: 'border-transparent bg-transparent text-inkMuted hover:bg-surfaceAlt hover:text-ink',
  danger: 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3.5 py-2 text-sm',
};

/** 生成按钮类名，供 `<button>` 与 `<Link>` 共用，保证外观一致。 */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]}`;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

/** 标准按钮。 */
export function Button({ variant = 'secondary', size = 'md', className, children, ...rest }: ButtonProps) {
  return (
    <button className={[buttonClass(variant, size), className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </button>
  );
}
