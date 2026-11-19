/**
 * `/grammar/[id]` EGIU 单元详情（T21 详情 + T23 复测历史）。
 */

import { notFound } from 'next/navigation';
import { getEgiuLessonDetail } from '@/lib/queries/egiu';
import { GrammarDetailBody } from '@/components/grammar/GrammarDetailBody';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function GrammarDetailPage({ params }: PageProps) {
  const { id } = await params;
  const detail = await getEgiuLessonDetail(id);
  if (!detail) notFound();

  return <GrammarDetailBody detail={detail} />;
}
