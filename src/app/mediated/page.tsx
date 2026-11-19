/**
 * `/mediated` 英语媒介学习工作区（v2.0 三轨道之一）。
 *
 * 一次完整的「用英语学知识」闭环：录入主题/材料/理解度/翻译依赖 + 英文产出
 * （笔记/摘要/问题），落 `EnglishMediatedSession` + `StudySession`（媒介轨道快照）
 * + 产出清单，顶部独立 gate 判定（不与 CEFR/IELTS 换算）。
 */

import { getMediatedOverview, listMediatedSessions } from '@/lib/queries/mediated';
import { getProfile } from '@/lib/queries/profile';
import { MediatedPageBody } from '@/components/mediated/MediatedPageBody';

export const dynamic = 'force-dynamic';

export default async function MediatedPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const params = await searchParams;
  const [sessions, overview, profile] = await Promise.all([
    listMediatedSessions(),
    getMediatedOverview(),
    getProfile(),
  ]);

  return (
    <MediatedPageBody
      sessions={sessions}
      overview={overview}
      defaultSubject={profile?.mediatedSubject ?? 'French'}
      showForm={params.new === '1'}
    />
  );
}
