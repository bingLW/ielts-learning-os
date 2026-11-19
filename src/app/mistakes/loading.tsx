/** `/mistakes` 错题本加载态。 */

import { PageSkeleton } from '@/components/ui/Skeleton';

export default function Loading() {
  return <PageSkeleton blocks={4} />;
}
