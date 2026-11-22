/** `/diagnostics/report/[id]` 诊断报告：画像、证据、复测与计划草案。 */

import { notFound } from 'next/navigation';
import { DiagnosticReport } from '@/components/diagnostics/DiagnosticReport';
import { getDiagnosticReport } from '@/lib/queries/diagnostics';

export const dynamic = 'force-dynamic';

export default async function DiagnosticReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const report = await getDiagnosticReport(id);
  if (!report) notFound();
  return <DiagnosticReport report={report} />;
}
