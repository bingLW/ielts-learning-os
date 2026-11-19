'use client';

/**
 * 记录列表页主体：新建表单开关 + 筛选 + 表格/空态 + 轻提示。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ResourceOptionDto, StudyRecordRowDto } from '@/lib/types';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import { RecordFilters, type RecordFiltersProps } from './RecordFilters';
import { RecordForm } from './RecordForm';
import { RecordTable } from './RecordTable';

export interface RecordsPageBodyProps {
  rows: StudyRecordRowDto[];
  filters: RecordFiltersProps;
  stages: { id: string; nameZh: string }[];
  resources: ResourceOptionDto[];
  defaultStageId: string;
  defaultRecordDate: string;
  showForm: boolean;
  totalCount: number;
}

export function RecordsPageBody({
  rows,
  filters,
  stages,
  resources,
  defaultStageId,
  defaultRecordDate,
  showForm,
  totalCount,
}: RecordsPageBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">学习记录</h1>
          <p className="text-xs text-inkMuted">
            共 {totalCount} 条（含筛选）· 每条记录必须有可检查产出 · 按日期倒序
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {showForm ? (
            <Link href="/records" className={buttonClass('secondary', 'sm')}>
              收起表单
            </Link>
          ) : (
            <Link href="/records?new=1" className={buttonClass('primary', 'sm')}>
              <Icon name="plus" size={13} />
              新建记录
            </Link>
          )}
        </div>
      </div>

      {showForm && (
        <RecordForm
          mode="create"
          stages={stages}
          resources={resources}
          defaultStageId={defaultStageId}
          defaultRecordDate={defaultRecordDate}
          onToast={show}
          onSaved={() => router.push('/records')}
        />
      )}

      <Card title="筛选" dense>
        <RecordFilters {...filters} />
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          icon="list"
          title="还没有学习记录"
          description="记录是本产品的核心资产：没有记录，Dashboard 的时长、完成率、正确率、薄弱点全部没有数据来源。"
          dependencies={[
            '至少一个阶段（记录必须挂在阶段上）',
            '资源库已 seed（可选，用于关联教材）',
            '计划页已生成当日任务（推荐从这里进入）',
          ]}
          primary={{ label: '新建第一条记录', href: '/records?new=1' }}
          secondary={{ label: '去今日计划', href: '/plan' }}
        />
      ) : (
        <Card title="记录列表" description="点击「详情」查看与编辑；归档为软删除。">
          <RecordTable rows={rows} onToast={show} />
        </Card>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
