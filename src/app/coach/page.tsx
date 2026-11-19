/**
 * `/coach` AI Learning Coach：协议步骤 + AI 使用日志。
 *
 * 这里不调用外部 AI 服务，也不读取对话原文；只记录本地使用与采纳情况。
 */

import { CoachPageBody } from '@/components/coach/CoachPageBody';
import { getAiUsageStats, listRecentAiUsage } from '@/lib/queries/aiUsage';
import { listEvidencePickerOptions } from '@/lib/queries/evidence';

export const dynamic = 'force-dynamic';

export default async function CoachPage() {
  const [usage, options] = await Promise.all([
    listRecentAiUsage(),
    listEvidencePickerOptions(),
  ]);
  const stats = getAiUsageStats(usage);
  return <CoachPageBody usage={usage} options={options} stats={stats} />;
}
