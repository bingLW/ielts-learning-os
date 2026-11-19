/** `/grammar` 加载态：EGIU 列表 + 三色分桶需要查两次，用骨架顶住布局。 */

import { PageSkeleton } from '@/components/ui/Skeleton';

export default function Loading() {
  return <PageSkeleton blocks={4} />;
}
