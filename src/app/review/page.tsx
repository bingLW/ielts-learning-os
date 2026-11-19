/**
 * `/review` 复习中心（T28）。
 *
 * 聚合四类目标（EGIU 单元 / 错题 / 单词 / 语法点）的待复习任务，
 * 按到期日分三桶：逾期 / 今日 / 本周。逾期不隐藏、不改期。
 */

import { getReviewCenter } from '@/lib/queries/reviews';
import { ReviewCenterBody } from '@/components/review/ReviewCenterBody';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const center = await getReviewCenter();
  return <ReviewCenterBody center={center} />;
}
