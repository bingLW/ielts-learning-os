/** `/vocabulary` 词汇加载态：词表 + 三档统计 + 抽测候选池。 */

import { PageSkeleton } from '@/components/ui/Skeleton';

export default function Loading() {
  return <PageSkeleton blocks={4} />;
}
