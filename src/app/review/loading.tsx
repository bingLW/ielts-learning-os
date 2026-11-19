/** `/review` 复习中心加载态：三个分桶 + 低频池需要一次聚合查询。 */

import { PageSkeleton } from '@/components/ui/Skeleton';

export default function Loading() {
  return <PageSkeleton blocks={4} />;
}
