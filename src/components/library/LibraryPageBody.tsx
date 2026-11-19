'use client';

/**
 * 方法论资料库页主体：统计 + 筛选 + 清单 + 阅读日志编辑。
 *
 * 本页只存链接、许可、阶段适配和个人摘要/实践记录，不复制任何原文。
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  LIBRARY_NO_COPY_NOTE_ZH,
  LIBRARY_STATUS_RULE_NOTE_ZH,
  METHODOLOGY_CATEGORIES,
  METHODOLOGY_CATEGORY_LABEL_ZH,
  METHODOLOGY_CATEGORY_NOTE_ZH,
  RESOURCE_PRIORITIES,
  RESOURCE_PRIORITY_LABEL_ZH,
  RESOURCE_READ_STATUS_LABEL_ZH,
  RESOURCE_READ_STATUSES,
} from '@/lib/constants';
import type {
  LibraryEvidenceOptionDto,
  MethodologyCategory,
  MethodologyResourceDto,
  ResourcePriority,
  ResourceReadStatus,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';
import { selectClass } from '@/components/ui/FormField';
import { LibraryItem } from './LibraryItem';

export interface LibraryStats {
  total: number;
  started: number;
  summarized: number;
  applied: number;
  done: number;
  byPriority: Record<ResourcePriority, { total: number; started: number; done: number }>;
}

export interface LibraryPageBodyProps {
  resources: MethodologyResourceDto[];
  stats: LibraryStats;
  evidenceOptions: LibraryEvidenceOptionDto[];
}

export function LibraryPageBody({ resources, stats, evidenceOptions }: LibraryPageBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [priorityFilter, setPriorityFilter] = useState<ResourcePriority | 'ALL'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<MethodologyCategory | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<ResourceReadStatus | 'ALL' | 'NONE'>('ALL');

  const filtered = resources.filter((item) => {
    if (priorityFilter !== 'ALL' && item.priority !== priorityFilter) return false;
    if (categoryFilter !== 'ALL' && item.category !== categoryFilter) return false;
    const status = item.reading?.status ?? 'NONE';
    if (statusFilter !== 'ALL' && status !== statusFilter) return false;
    return true;
  });

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-base font-semibold text-ink">方法论资料库</h1>
        <p className="text-xs text-inkMuted">
          16 条预设来源 · 只存链接、许可与阅读日志 · 打开原站不算掌握
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile
          label="收录资料"
          value={stats.total}
          unit="条"
          tone="neutral"
          scopeNote="ResourceReference（seed 维护）"
        />
        <StatTile
          label="已开始"
          value={stats.started}
          unit="条"
          tone="actual"
          scopeNote="状态不是「未开始」"
        />
        <StatTile
          label="已写摘要"
          value={stats.summarized}
          unit="条"
          tone="output"
          scopeNote="含已实践/已完成"
        />
        <StatTile
          label="已完成"
          value={stats.done}
          unit="条"
          tone="mastery"
          scopeNote="必须填写实践计划"
        />
      </div>

      <Card title="使用规则" description="先写自己的摘要，再做一次实践，最后才标记完成">
        <ul className="space-y-1 text-[11px] leading-relaxed text-inkMuted">
          <li>· {LIBRARY_NO_COPY_NOTE_ZH}</li>
          <li>· {LIBRARY_STATUS_RULE_NOTE_ZH}</li>
          <li>
            · P0 先开始 {stats.byPriority.P0.started}/{stats.byPriority.P0.total} · P1{' '}
            {stats.byPriority.P1.started}/{stats.byPriority.P1.total} · P2{' '}
            {stats.byPriority.P2.started}/{stats.byPriority.P2.total}
          </li>
        </ul>
      </Card>

      {resources.length === 0 ? (
        <EmptyState
          icon="bookOpen"
          title="资料库还没有数据"
          description="预设的 16 条方法论来源由 seed 写入（只写元数据与许可说明，不含原文）。"
          dependencies={['在项目根目录执行：node scripts/seed-library.mjs（幂等，可重复运行）']}
          secondary={{ label: '回 Dashboard', href: '/' }}
        />
      ) : (
        <Card
          title="资料清单"
          description={`共 ${resources.length} 条 · 当前显示 ${filtered.length} 条 · 按优先级与排序展示`}
          actions={
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                aria-label="按优先级筛选"
                value={priorityFilter}
                onChange={(event) => setPriorityFilter(event.target.value as ResourcePriority | 'ALL')}
                className={`${selectClass} w-auto`}
              >
                <option value="ALL">全部优先级</option>
                {RESOURCE_PRIORITIES.map((item) => (
                  <option key={item} value={item}>
                    {RESOURCE_PRIORITY_LABEL_ZH[item]}
                  </option>
                ))}
              </select>
              <select
                aria-label="按分类筛选"
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value as MethodologyCategory | 'ALL')}
                className={`${selectClass} w-auto`}
              >
                <option value="ALL">全部分类</option>
                {METHODOLOGY_CATEGORIES.map((item) => (
                  <option key={item} value={item}>
                    {METHODOLOGY_CATEGORY_LABEL_ZH[item]}
                  </option>
                ))}
              </select>
              <select
                aria-label="按阅读状态筛选"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as ResourceReadStatus | 'ALL' | 'NONE')
                }
                className={`${selectClass} w-auto`}
              >
                <option value="ALL">全部状态</option>
                <option value="NONE">未记录</option>
                {RESOURCE_READ_STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {RESOURCE_READ_STATUS_LABEL_ZH[item]}
                  </option>
                ))}
              </select>
            </div>
          }
        >
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-xs text-inkMuted">没有符合筛选条件的资料。</p>
          ) : (
            <ul className="divide-y divide-line">
              {filtered.map((item) => (
                <LibraryItem
                  key={item.id}
                  resource={item}
                  evidenceOptions={evidenceOptions}
                  onToast={show}
                  onSaved={() => router.refresh()}
                />
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="分类口径" description="分类用于筛选，不代表难度顺序">
        <div className="grid gap-1 text-[11px] text-inkMuted sm:grid-cols-2">
          {METHODOLOGY_CATEGORIES.map((category) => (
            <p key={category}>
              · <span className="font-medium text-ink">{METHODOLOGY_CATEGORY_LABEL_ZH[category]}</span>
              ：{METHODOLOGY_CATEGORY_NOTE_ZH[category]}
            </p>
          ))}
        </div>
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
