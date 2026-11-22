/**
 * `/materials/[id]/processing` 处理状态。
 *
 * Next 15 的动态路由参数是 `Promise`，必须 `await params`。
 * 材料不存在 → `notFound()`（交给全局 not-found 页）。
 */

import { notFound } from 'next/navigation';
import { ProcessingStatusBody } from '@/components/materials/ProcessingStatusBody';
import { getMaterialHeader, getMaterialStatus } from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MaterialProcessingPage({ params }: PageProps) {
  const { id } = await params;
  const [status, header] = await Promise.all([getMaterialStatus(id), getMaterialHeader(id)]);
  if (!status) notFound();

  return <ProcessingStatusBody initial={status} header={header} />;
}
