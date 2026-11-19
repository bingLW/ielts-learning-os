/**
 * `/resources` 资源库。
 */

import { listResources } from '@/lib/queries/resources';
import { ResourcesPageBody } from '@/components/resources/ResourcesPageBody';

export const dynamic = 'force-dynamic';

export default async function ResourcesPage() {
  const rows = await listResources();
  return <ResourcesPageBody rows={rows} />;
}
