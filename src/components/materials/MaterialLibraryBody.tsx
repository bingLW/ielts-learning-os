'use client';

/**
 * 材料库页主体：标题区 + 筛选条 + 卡片列表 + 空状态。
 *
 * 页面本身是 Server Component（`/materials/page.tsx`），本组件只负责交互层，
 * 数据全部来自 props（DTO 已经是可序列化的普通对象）。
 */

import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { MaterialCardDto } from '@/lib/queries/materials';
import { MaterialCard } from './MaterialCard';
import { MaterialFilterBar } from './MaterialFilterBar';

export function MaterialLibraryBody({
  rows,
  totalCount,
  failedCount,
}: {
  rows: MaterialCardDto[];
  totalCount: number;
  failedCount: number;
}) {
  const filtering = rows.length !== totalCount;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">材料库（Smart Materials）</h1>
          <p className="text-xs text-inkMuted">
            共 {totalCount} 份材料
            {failedCount > 0 ? ` · ${failedCount} 份链接失败待重试` : ''}
            {' · '}导入的原文不可篡改，AI 产出全部标注来源
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Link href="/materials/failed" className={buttonClass('secondary', 'sm')}>
            <Icon name="alert" size={13} />
            导入失败{failedCount > 0 ? `（${failedCount}）` : ''}
          </Link>
          <Link href="/materials/import" className={buttonClass('primary', 'sm')}>
            <Icon name="plus" size={13} />
            导入材料
          </Link>
        </div>
      </div>

      <MaterialFilterBar />

      {rows.length === 0 ? (
        <EmptyState
          icon="bookOpen"
          title={filtering ? '这个筛选条件下没有材料' : '材料库还是空的'}
          description={
            filtering
              ? '换个状态/格式试试，或重置筛选。'
              : '导入一份你自己的英文材料（TXT / Markdown / HTML / PDF / Word），或先粘贴一段摘录试试。'
          }
          dependencies={
            filtering
              ? undefined
              : ['导入向导可用（无需额外配置）', 'AI 分析需要先在设置里配置模型凭证']
          }
          primary={{ label: '导入材料', href: '/materials/import' }}
          secondary={filtering ? { label: '重置筛选', href: '/materials' } : undefined}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((item) => (
            <MaterialCard key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
