/**
 * `/vocabulary/connection` 外部引擎连接与固定版本说明。
 */

import {
  TYPEWORDS_KNOWN_LIMITS_ZH,
  TYPEWORDS_LICENSE,
  TYPEWORDS_LICENSE_SHA256,
  TYPEWORDS_PINNED_COMMIT,
  TYPEWORDS_PINNED_DATE,
  VOCAB_INTEGRATION_MODE_LABEL_ZH,
} from '@/lib/constants';
import { formatBusinessDateTime } from '@/lib/date';
import { listVocabConnections } from '@/lib/queries/vocabIntegration';
import { Card } from '@/components/ui/Card';
import { VocabConnectionToggle } from '@/components/vocabulary/VocabConnectionToggle';

export const dynamic = 'force-dynamic';

export default async function VocabularyConnectionPage() {
  const connections = await listVocabConnections();

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-base font-semibold text-ink">连接与版本</h1>
        <p className="text-xs text-inkMuted">
          这里不保存任何第三方账号或密码；连接只是「哪份文件、哪个固定版本」的登记。
        </p>
      </header>

      <Card title="外部引擎连接" description="FILE = 文件交换；BRIDGE = 浏览器桥（默认关闭，未启用）">
        {connections.length === 0 ? (
          <p className="text-xs text-inkMuted">
            没有连接记录：数据库迁移 v2.3 会自动登记一条 TypeWords 文件连接。
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {connections.map((connection) => (
              <li key={connection.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="text-xs">
                  <p className="font-medium text-ink">
                    {connection.name}
                    <span className="ml-2 font-normal text-inkMuted">
                      {VOCAB_INTEGRATION_MODE_LABEL_ZH[connection.mode] ?? connection.mode}
                    </span>
                  </p>
                  <p className="text-[11px] text-inkMuted">
                    固定版本 {connection.pinnedVersion ?? '—'}
                    {connection.lastSyncAt ? ` · 最近同步 ${formatBusinessDateTime(connection.lastSyncAt)}` : ''}
                  </p>
                  {connection.licenseNote && (
                    <p className="text-[11px] text-inkMuted">{connection.licenseNote}</p>
                  )}
                </div>
                <VocabConnectionToggle connection={connection} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="固定审计基线" description="解析器、字段映射与导出格式都以这个 commit 为准">
        <dl className="grid gap-2 text-[11px] md:grid-cols-2">
          <div>
            <dt className="text-inkMuted">commit</dt>
            <dd className="break-all text-ink">{TYPEWORDS_PINNED_COMMIT}</dd>
          </div>
          <div>
            <dt className="text-inkMuted">审计日期</dt>
            <dd className="text-ink">{TYPEWORDS_PINNED_DATE}</dd>
          </div>
          <div>
            <dt className="text-inkMuted">许可</dt>
            <dd className="text-ink">{TYPEWORDS_LICENSE}</dd>
          </div>
          <div>
            <dt className="text-inkMuted">LICENSE sha256</dt>
            <dd className="break-all text-ink">{TYPEWORDS_LICENSE_SHA256}</dd>
          </div>
        </dl>
      </Card>

      <Card title="已知限制" description="来自源码审计，不做运行时猜测">
        <ul className="list-disc space-y-1 pl-4 text-[11px] text-inkMuted">
          {TYPEWORDS_KNOWN_LIMITS_ZH.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
