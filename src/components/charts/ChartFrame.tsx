'use client';

/**
 * 图表容器（T30）。
 *
 * Recharts 依赖真实 DOM 尺寸，SSR 阶段没有 `window`，直接渲染会报错或出现
 * 0 宽度图。这里用「挂载守卫」：首屏渲染占位块，`useEffect` 之后才渲染真正的图表。
 * 这比 `dynamic(..., { ssr: false })` 更细粒度（同一页面其它内容照常 SSR）。
 */

import { useEffect, useState, type ReactNode } from 'react';

export interface ChartFrameProps {
  height?: number;
  children: ReactNode;
  /** 无障碍描述：图表必须有文字替代表述。 */
  ariaLabel?: string;
}

export function ChartFrame({ height = 200, children, ariaLabel }: ChartFrameProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div
        className="w-full animate-pulse rounded-md border border-dashed border-line bg-surfaceAlt"
        style={{ height }}
        aria-hidden="true"
      />
    );
  }

  return (
    <div className="w-full" style={{ height }} role="img" aria-label={ariaLabel ?? '数据图表'}>
      {children}
    </div>
  );
}
