'use client';

/**
 * 资源库页主体：新增/编辑表单 + 表格 + 轻提示。
 */

import { useState } from 'react';
import type { ResourceRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import { ResourceForm } from './ResourceForm';
import { ResourceTable } from './ResourceTable';

export function ResourcesPageBody({ rows }: { rows: ResourceRowDto[] }) {
  const { toast, show, dismiss } = useToastState();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ResourceRowDto | null>(null);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (row: ResourceRowDto) => {
    setEditing(row);
    setFormOpen(true);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">资源库</h1>
          <p className="text-xs text-inkMuted">
            {rows.length} 个在用资源 · 初始 8 类由 seed 写入 · 代码中不含任何资源名
          </p>
        </div>
        {!formOpen && (
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Icon name="plus" size={13} />
            新增资源
          </Button>
        )}
      </div>

      {formOpen && (
        <ResourceForm
          key={editing?.id ?? 'new'}
          editing={editing}
          onToast={show}
          onDone={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon="folder"
          title="资源库还没有数据"
          description="资源是计划与记录的选项来源。先运行 seed 写入 8 类初始资源，或手动新增。"
          dependencies={['prisma/seed.ts 已执行（写入 8 类初始资源）']}
          primary={{ label: '新增资源', onClick: openCreate }}
        />
      ) : (
        <Card title="资源列表" description="SOP 建议每项能力固定一个主材料并连续使用 ≥4 周。">
          <ResourceTable rows={rows} onEdit={openEdit} onToast={show} />
        </Card>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
