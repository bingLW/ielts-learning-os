/**
 * `/vocabulary/sync` 文件交换与同步审计。
 */

import { listIntegrationJobs } from '@/lib/queries/vocabIntegration';
import { VocabSyncBody } from '@/components/vocabulary/VocabSyncBody';

export const dynamic = 'force-dynamic';

export default async function VocabularySyncPage() {
  const jobs = await listIntegrationJobs(30);
  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-base font-semibold text-ink">数据交换（同步中心）</h1>
        <p className="text-xs text-inkMuted">
          v2.3 只启用 L1 文件交换：导出兼容包 → 在 TypeWords 导入 → 练习后导出备份 → 回到这里导入。
          L2 浏览器桥接默认关闭。
        </p>
      </header>
      <VocabSyncBody jobs={jobs} />
    </div>
  );
}
