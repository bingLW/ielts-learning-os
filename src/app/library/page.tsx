/**
 * `/library` 方法论资料库。
 *
 * 只展示 16 条预设来源的元数据/许可/阅读日志；不渲染、不缓存原站正文。
 */

import { LibraryPageBody } from '@/components/library/LibraryPageBody';
import { getLibraryBoard } from '@/lib/queries/library';

export const dynamic = 'force-dynamic';

export default async function LibraryPage() {
  const { resources, stats, evidenceOptions } = await getLibraryBoard();
  return <LibraryPageBody resources={resources} stats={stats} evidenceOptions={evidenceOptions} />;
}
