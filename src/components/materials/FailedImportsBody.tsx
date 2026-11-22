'use client';

/**
 * 导入失败页主体。
 *
 * 「同 contentHash 合并成一行」由 `listFailedMaterials()` 在服务端完成，
 * 这里只负责重试/删除后的刷新与提示。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import type { FailedMaterialDto } from '@/lib/queries/materials';
import { FailedRow } from './FailedRow';

export function FailedImportsBody({ rows }: { rows: FailedMaterialDto[] }) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const totalRecords = rows.reduce((sum, item) => sum + item.occurrences, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">导入失败与重试</h1>
          <p className="text-xs text-inkMuted">
            {rows.length} 份内容失败（{totalRecords} 条记录）· 重试不需要重新上传，原文仍在本地存储中
          </p>
        </div>
        <Link href="/materials/import" className={buttonClass('primary', 'sm')}>
          <Icon name="plus" size={13} />
          重新导入
        </Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="check"
          title="没有失败的导入"
          description="所有材料都处理完成，或还没有导入过材料。"
          primary={{ label: '材料库', href: '/materials' }}
          secondary={{ label: '导入材料', href: '/materials/import' }}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((item) => (
            <FailedRow
              key={item.contentHash}
              item={item}
              onToast={show}
              onChanged={() => router.refresh()}
            />
          ))}
        </ul>
      )}

      <div className="rounded-md border border-line bg-surfaceAlt p-2.5 text-[11px] leading-relaxed text-inkMuted">
        常见原因：文件内容与扩展名不一致（改扩展名无效，系统按文件头判断）、PDF 是纯扫描件没有文本层、
        PDF 超过 200 页、Word 压缩包结构异常。若多次失败，可先把内容另存为纯文本再导入。
      </div>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
