/**
 * 卡片容器。`title` + `description` + `actions` 三段式，保证 12 个 Dashboard 区块
 * 的排版与标题层级一致。
 */

import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 紧凑模式：用于密集信息块（仪表盘小卡）。 */
  dense?: boolean;
}

export function Card({ title, description, actions, children, className, dense = false }: CardProps) {
  return (
    <section
      className={[
        'rounded-lg border border-line bg-surface',
        dense ? 'p-3' : 'p-4',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {(title || actions) && (
        <header className="mb-2 flex items-start justify-between gap-2">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-inkMuted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** 区块小标题（不需要卡片外壳时使用）。 */
export function SectionTitle({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-inkMuted">{children}</h3>
      {hint && <span className="text-xs text-inkMuted">{hint}</span>}
    </div>
  );
}
