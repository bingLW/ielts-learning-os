/**
 * 路由级加载态（骨架屏）。
 */

import { PageSkeleton } from '@/components/ui/Skeleton';

export default function Loading() {
  return <PageSkeleton blocks={6} />;
}
