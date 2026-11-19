'use client';

/**
 * 记录详情页主体：编辑表单 + 修订历史 + 轻提示。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ResourceOptionDto, RevisionRowDto, StudyRecordDetailDto } from '@/lib/types';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Toast, useToastState } from '@/components/ui/Toast';
import { RecordForm } from './RecordForm';
import { RevisionList } from './RevisionList';

export function RecordDetailBody({
  record,
  revisions,
  stages,
  resources,
}: {
  record: StudyRecordDetailDto;
  revisions: RevisionRowDto[];
  stages: { id: string; nameZh: string }[];
  resources: ResourceOptionDto[];
}) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">记录详情</h1>
          <p className="text-xs text-inkMuted">
            创建于 {record.createdAt.slice(0, 19).replace('T', ' ')} · 最后更新{' '}
            {record.updatedAt.slice(0, 19).replace('T', ' ')}
          </p>
        </div>
        <Link href="/records" className={buttonClass('secondary', 'sm')}>
          返回列表
        </Link>
      </div>

      <RecordForm
        mode="edit"
        initial={record}
        stages={stages}
        resources={resources}
        defaultStageId={record.stageId}
        defaultRecordDate={record.recordDate}
        onToast={show}
        onSaved={() => router.refresh()}
      />

      <Card title="修订历史（最近 10 次）" description="每次编辑逐字段留痕，只增不删。">
        <RevisionList revisions={revisions} />
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
