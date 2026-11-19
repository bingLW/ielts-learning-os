/**
 * `/records/[id]` 记录详情 / 编辑。
 */

import { notFound } from 'next/navigation';
import { getRecordDetail, listRevisions } from '@/lib/queries/records';
import { listResourceOptions } from '@/lib/queries/plan';
import { listStagesRaw } from '@/lib/queries/stages';
import { RecordDetailBody } from '@/components/records/RecordDetailBody';

export const dynamic = 'force-dynamic';

export default async function RecordDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const record = await getRecordDetail(id);
  if (!record) notFound();

  const [revisions, resources, stagesRaw] = await Promise.all([
    listRevisions(record.id),
    listResourceOptions(),
    listStagesRaw(),
  ]);

  return (
    <RecordDetailBody
      record={record}
      revisions={revisions}
      stages={stagesRaw.map((stage) => ({ id: stage.id, nameZh: stage.nameZh }))}
      resources={resources}
    />
  );
}
