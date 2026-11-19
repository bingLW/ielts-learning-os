/**
 * 空状态。
 *
 * PRD 要求每个页面都说明「本页依赖哪些前置数据」并给出「直达创建入口」，
 * 所以这里同时支持 `dependencies` 文案与双 CTA（主行动 + 次行动）。
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonClass } from './Button';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** 前置依赖说明，例如「需要先激活一个阶段」。 */
  dependencies?: string[];
  primary?: { label: string; href?: string; onClick?: () => void };
  secondary?: { label: string; href?: string; onClick?: () => void };
  icon?: IconName;
}

export function EmptyState({
  title,
  description,
  dependencies,
  primary,
  secondary,
  icon = 'circle',
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line bg-surface px-5 py-10 text-center">
      <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surfaceAlt text-inkMuted">
        <Icon name={icon} size={20} />
      </span>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-md text-xs text-inkMuted">{description}</p>}

      {dependencies && dependencies.length > 0 && (
        <div className="mt-3 w-full max-w-md rounded-md border border-line bg-surfaceAlt p-2.5 text-left">
          <p className="mb-1 text-[11px] font-semibold text-inkMuted">本页依赖的前置数据</p>
          <ul className="list-inside list-disc space-y-0.5 text-[11px] text-inkMuted">
            {dependencies.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {(primary || secondary) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {primary &&
            (primary.href ? (
              <Link href={primary.href} className={buttonClass('primary', 'md')}>
                <Icon name="plus" size={14} />
                {primary.label}
              </Link>
            ) : (
              <button type="button" onClick={primary.onClick} className={buttonClass('primary', 'md')}>
                <Icon name="plus" size={14} />
                {primary.label}
              </button>
            ))}
          {secondary &&
            (secondary.href ? (
              <Link href={secondary.href} className={buttonClass('secondary', 'md')}>
                {secondary.label}
              </Link>
            ) : (
              <button
                type="button"
                onClick={secondary.onClick}
                className={buttonClass('secondary', 'md')}
              >
                {secondary.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
