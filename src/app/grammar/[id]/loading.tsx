/** `/grammar/[id]` 加载态：单元详情要装配复测时间线与掌握度变化。 */

import { PageSkeleton } from '@/components/ui/Skeleton';

export default function Loading() {
  return <PageSkeleton blocks={4} />;
}
