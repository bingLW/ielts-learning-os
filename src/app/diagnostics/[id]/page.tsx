/**
 * `/diagnostics/[id]` 诊断会话工作区。
 *
 * 不在服务端渲染题目的标准答案；未作答题目不下发 correctAnswer/explanation。
 */

import { notFound } from 'next/navigation';
import { DiagnosticWorkspace } from '@/components/diagnostics/DiagnosticWorkspace';
import { getDiagnosticSessionDetail } from '@/lib/queries/diagnostics';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function DiagnosticSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [session, profile] = await Promise.all([
    getDiagnosticSessionDetail(id),
    prisma.learnerProfile.findUnique({ where: { id: 'default' } }),
  ]);
  if (!session) notFound();
  return (
    <DiagnosticWorkspace session={session} recordingConsent={Boolean(profile?.recordingConsent)} />
  );
}
