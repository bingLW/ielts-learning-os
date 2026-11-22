/**
 * `/materials/failed` 导入失败与重试。
 */

import { FailedImportsBody } from '@/components/materials/FailedImportsBody';
import { listFailedMaterials } from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';

export default async function FailedImportsPage() {
  const rows = await listFailedMaterials();
  return <FailedImportsBody rows={rows} />;
}
