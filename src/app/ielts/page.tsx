/**
 * `/ielts` 雅思工作区（v2.0 P4）。
 *
 * 独立 gate + 目标差距 + 成绩趋势（总分/四单项）+ 正式 vs 模考分区。
 * IELTS gate 只看 IeltsAssessment，与 CEFR 评估、媒介学习互不换算。
 */

import { getIeltsOverview } from '@/lib/queries/assessment';
import { IeltsPageBody } from '@/components/ielts/IeltsPageBody';

export const dynamic = 'force-dynamic';

export default async function IeltsPage() {
  const overview = await getIeltsOverview();

  return <IeltsPageBody overview={overview} />;
}
