/**
 * `/diagnostics` AI 初始诊断入口。
 *
 * 数据口径：诊断会话与报告 append-only；这里只列历史，不覆盖旧记录。
 */

import { DiagnosticsHome } from '@/components/diagnostics/DiagnosticsHome';
import { listDiagnosticSessions } from '@/lib/queries/diagnostics';

export const dynamic = 'force-dynamic';

export default async function DiagnosticsPage() {
  const sessions = await listDiagnosticSessions();
  return <DiagnosticsHome sessions={sessions} />;
}
