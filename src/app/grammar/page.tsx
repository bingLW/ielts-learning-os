/**
 * `/grammar` 语法诊断（EGIU）—— 列表页（T21）。
 */

import { getActiveStage, listStagesRaw } from '@/lib/queries/stages';
import { listResourceOptions } from '@/lib/queries/plan';
import { getEgiuSummary, listEgiuLessons } from '@/lib/queries/egiu';
import { EGIU_COLORS } from '@/lib/constants';
import type { EgiuColor } from '@/lib/types';
import { GrammarPageBody } from '@/components/grammar/GrammarPageBody';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 取单值 query 参数。 */
function one(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function GrammarPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const stageId = one(params, 'stageId');
  const colorRaw = one(params, 'color');
  const color = (EGIU_COLORS as readonly string[]).includes(colorRaw)
    ? (colorRaw as EgiuColor)
    : 'ALL';
  const q = one(params, 'q');

  const [rows, summary, stages, resources, activeStage] = await Promise.all([
    listEgiuLessons({ stageId: stageId || null, color, q }),
    getEgiuSummary(),
    listStagesRaw(),
    listResourceOptions(),
    getActiveStage(),
  ]);

  return (
    <GrammarPageBody
      rows={rows}
      summary={summary}
      stages={stages.map((stage) => ({ id: stage.id, nameZh: stage.nameZh, code: stage.code }))}
      resources={resources}
      activeStageId={activeStage?.id ?? null}
      activeStageCode={activeStage?.code ?? null}
      filter={{ stageId, color, q }}
    />
  );
}
