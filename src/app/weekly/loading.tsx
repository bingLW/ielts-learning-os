/**
 * `/weekly` 加载态。
 *
 * 两个 Tab（周复盘 / 数据分析）共用本骨架：数据分析一次要跑十组聚合，
 * 先出骨架比先出一个空图表骨架更不容易让用户误以为「没数据」。
 */

import { PageSkeleton } from '@/components/ui/Skeleton';

export default function Loading() {
  return <PageSkeleton blocks={6} />;
}
