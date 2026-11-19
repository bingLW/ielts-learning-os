/**
 * `/evidence` Evidence Center。
 *
 * 数据口径：列表包含归档（由页面勾选过滤），统计只按活动证据计算。
 * 带 `?retest=<scheduleId>` 进入时，表单锁定为对应复测阶段并在保存后完成排期。
 */

import { EvidencePageBody } from '@/components/evidence/EvidencePageBody';
import { getEvidenceStats, listEvidenceDetails } from '@/lib/queries/evidence';
import { getRetestCompletionContext } from '@/lib/queries/retest';

export const dynamic = 'force-dynamic';

export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<{ retest?: string }>;
}) {
  const params = await searchParams;
  const [rows, stats, retestContext] = await Promise.all([
    listEvidenceDetails({ includeArchived: true }),
    getEvidenceStats(),
    params.retest ? getRetestCompletionContext(params.retest) : Promise.resolve(null),
  ]);
  return <EvidencePageBody rows={rows} stats={stats} retestContext={retestContext} />;
}
