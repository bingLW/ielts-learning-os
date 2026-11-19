/**
 * `/diagnosis` 障碍诊断与定向修复。
 *
 * 数据口径：列表包含归档（由页面勾选过滤），统计只算未归档记录。
 */

import { DiagnosisPageBody } from '@/components/diagnosis/DiagnosisPageBody';
import { getBarrierStats, listBarrierEvidenceOptions, listDiagnosisBarriers } from '@/lib/queries/barrier';

export const dynamic = 'force-dynamic';

export default async function DiagnosisPage() {
  const [rows, optionsBySkill] = await Promise.all([
    listDiagnosisBarriers(true),
    listBarrierEvidenceOptions(),
  ]);
  const stats = await getBarrierStats(rows);
  return <DiagnosisPageBody rows={rows} optionsBySkill={optionsBySkill} stats={stats} />;
}
