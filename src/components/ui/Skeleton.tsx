/**
 * 骨架屏。加载态一律用骨架，不用「加载中…」纯文字，避免布局跳动。
 */

export function SkeletonLine({ width = '100%', height = 12 }: { width?: string; height?: number }) {
  return (
    <div
      className="animate-pulse rounded bg-line"
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

/** 一块卡片骨架。 */
export function SkeletonBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <SkeletonLine width="35%" />
      <div className="mt-3 space-y-2">
        {Array.from({ length: rows }).map((_, index) => (
          <SkeletonLine key={index} width={index % 2 === 0 ? '90%' : '75%'} />
        ))}
      </div>
    </div>
  );
}

/** 页面级骨架（`loading.tsx` 使用）。 */
export function PageSkeleton({ blocks = 4 }: { blocks?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="正在加载">
      <SkeletonLine width="30%" height={20} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: blocks }).map((_, index) => (
          <SkeletonBlock key={index} rows={3} />
        ))}
      </div>
      <span className="sr-only">正在加载数据</span>
    </div>
  );
}
