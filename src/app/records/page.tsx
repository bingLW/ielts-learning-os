/**
 * `/records` 学习记录列表页。
 */

import { today } from '@/lib/date';
import { listRecords, countRecords } from '@/lib/queries/records';
import { listResourceOptions } from '@/lib/queries/plan';
import { listStagesRaw, getActiveStage } from '@/lib/queries/stages';
import { RecordsPageBody } from '@/components/records/RecordsPageBody';

export const dynamic = 'force-dynamic';

export default async function RecordsPage({
  searchParams,
}: {
  searchParams: Promise<{
    skill?: string;
    stageId?: string;
    resourceId?: string;
    fromDate?: string;
    toDate?: string;
    new?: string;
  }>;
}) {
  const params = await searchParams;
  const filters = {
    skill: params.skill || undefined,
    stageId: params.stageId || undefined,
    resourceId: params.resourceId || undefined,
    fromDate: params.fromDate || undefined,
    toDate: params.toDate || undefined,
  };

  const [rows, totalCount, resources, stagesRaw, activeStage] = await Promise.all([
    listRecords(filters),
    countRecords(filters),
    listResourceOptions(),
    listStagesRaw(),
    getActiveStage(),
  ]);

  const stages = stagesRaw.map((stage) => ({ id: stage.id, nameZh: stage.nameZh }));

  return (
    <RecordsPageBody
      rows={rows}
      filters={{ ...filters, stages, resources }}
      stages={stages}
      resources={resources}
      defaultStageId={activeStage?.id ?? stages[0]?.id ?? ''}
      defaultRecordDate={today()}
      showForm={params.new === '1'}
      totalCount={totalCount}
    />
  );
}
