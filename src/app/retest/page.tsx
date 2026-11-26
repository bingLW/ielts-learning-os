/**
 * `/retest` 复测与迁移验证。
 *
 * 数据口径：只读技能型复测排期；知识型复习仍在 /mistakes 与 /review。
 */

import { RetestPageBody } from '@/components/retest/RetestPageBody';
import { businessToday } from '@/lib/businessTime';
import { getRetestStats, listRetestQueue } from '@/lib/queries/retest';

export const dynamic = 'force-dynamic';

export default async function RetestPage() {
  const todayStr = await businessToday();
  const rows = await listRetestQueue();
  const stats = getRetestStats(rows, todayStr);
  return <RetestPageBody rows={rows} stats={stats} todayStr={todayStr} />;
}
