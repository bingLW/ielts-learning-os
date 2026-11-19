/**
 * `/general` 通用英语工作区（v2.0 P4）。
 *
 * 三个 Tab 由 `searchParams.tab` 在服务端分派（URL 状态，刷新/分享/后退一致）：
 *   - 默认（无 tab）→ CEFR 评估（独立 gate + 录入 + 历史）；
 *   - `?tab=allocation` → 四技能配比 vs 建议；
 *   - `?tab=milestones` → 阶段里程碑。
 */

import { getGeneralEnglishOverview } from '@/lib/queries/assessment';
import { GeneralPageBody, type GeneralTabKey } from '@/components/general/GeneralPageBody';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function GeneralPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const rawTab = one(params, 'tab');
  const activeTab: GeneralTabKey =
    rawTab === 'allocation' || rawTab === 'milestones' ? rawTab : 'assessment';

  const overview = await getGeneralEnglishOverview();

  return <GeneralPageBody overview={overview} activeTab={activeTab} />;
}
