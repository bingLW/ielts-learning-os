'use client';

/**
 * 错题本页主体（T25）。
 *
 * 筛选条件全部走 URL（服务端过滤），因此刷新/分享能复现同一视图。
 */

import Link from 'next/link';
import { useState } from 'react';
import { ERROR_CATEGORY_LABEL_ZH } from '@/lib/constants';
import type {
  ErrorCategory,
  IeltsErrorCategory,
  MistakeFilterState,
  MistakeRowDto,
  MistakeStatsDto,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';
import { MistakeForm } from './MistakeForm';
import { MistakeList } from './MistakeList';

export interface MistakesPageBodyProps {
  rows: MistakeRowDto[];
  stats: MistakeStatsDto;
  knowledgePoints: string[];
  stages: { id: string; nameZh: string }[];
  activeStageId: string | null;
  filter: MistakeFilterState;
  errorCategories: readonly ErrorCategory[];
  ieltsCategories: readonly IeltsErrorCategory[];
}

export function MistakesPageBody({
  rows,
  stats,
  knowledgePoints,
  stages,
  activeStageId,
  filter,
  errorCategories,
  ieltsCategories,
}: MistakesPageBodyProps) {
  const { toast, show, dismiss } = useToastState();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MistakeRowDto | null>(null);

  const filtered =
    filter.q !== '' ||
    filter.errorCategory !== 'ALL' ||
    filter.mastery !== 'ALL' ||
    filter.knowledgePoint !== '' ||
    filter.stageId !== '' ||
    filter.from !== '' ||
    filter.to !== '';

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (row: MistakeRowDto) => {
    setEditing(row);
    setFormOpen(true);
  };

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">错题本</h1>
          <p className="text-xs text-inkMuted">
            6 类错误类别必填 · 雅思 5 类错因仅 S3 启用 · 复习任务与其它类型共用一张表
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/review" className="text-[11px] text-brand hover:underline">
            复习中心 →
          </Link>
          {!formOpen && (
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Icon name="plus" size={13} />
              录入错题
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile label="错题总数" value={stats.total} unit="道" />
        <StatTile
          label="未掌握"
          value={stats.total - stats.mastered}
          unit="道"
          tone="warn"
          hint={`已掌握 ${stats.mastered} 道`}
        />
        <StatTile label="待复习任务" value={stats.pendingReviewTask} unit="条" tone="plan" />
        <StatTile
          label="高频知识点"
          value={stats.topKnowledgePoints[0]?.name ?? '—'}
          tone="neutral"
          hint={
            stats.topKnowledgePoints[0]
              ? `${stats.topKnowledgePoints[0].count} 道`
              : '暂无未掌握错题'
          }
        />
      </div>

      <Card title="筛选" description="全部条件在服务端生效">
        <form method="get" className="grid gap-2 mobile:grid-cols-2 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            关键词
            <input
              type="search"
              name="q"
              defaultValue={filter.q}
              placeholder="原题 / 知识点 / 原因"
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            错误类别
            <select
              name="errorCategory"
              defaultValue={filter.errorCategory}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="ALL">全部</option>
              {errorCategories.map((category) => (
                <option key={category} value={category}>
                  {ERROR_CATEGORY_LABEL_ZH[category]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            知识点
            <select
              name="knowledgePoint"
              defaultValue={filter.knowledgePoint}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="">全部</option>
              {knowledgePoints.map((point) => (
                <option key={point} value={point}>
                  {point}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            掌握状态
            <select
              name="mastery"
              defaultValue={filter.mastery}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="ALL">全部</option>
              <option value="UNMASTERED">未掌握</option>
              <option value="MASTERED">已掌握</option>
            </select>
          </label>
          <div className="flex items-end gap-1.5">
            <Button variant="secondary" size="sm" type="submit">
              筛选
            </Button>
            <Link href="/mistakes" className="text-[11px] text-brand underline">
              清空
            </Link>
          </div>
        </form>
      </Card>

      {formOpen && (
        <MistakeForm
          key={editing?.id ?? 'new'}
          editing={editing}
          stages={stages}
          defaultStageId={activeStageId}
          errorCategories={errorCategories}
          ieltsCategories={ieltsCategories}
          onToast={show}
          onDone={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      )}

      {rows.length === 0 ? (
        filtered ? (
          <EmptyState
            icon="alert"
            title="没有符合筛选条件的错题"
            description="换个条件，或清空筛选查看全部。"
            primary={{ label: '清空筛选', href: '/mistakes' }}
          />
        ) : (
          <EmptyState
            icon="alert"
            title="还没有错题记录"
            description="错题必须归类（6 类错误类别），否则无法聚合出薄弱知识点。录完可以直接生成复习任务。"
            dependencies={['已激活一个阶段', '有具体题目与正确答案']}
            primary={{ label: '录入第一道错题', onClick: openCreate }}
          />
        )
      ) : (
        <Card title={`错题列表（${rows.length}）`} description="勾选后可批量生成复习任务">
          <MistakeList rows={rows} onEdit={openEdit} onToast={show} />
        </Card>
      )}

      <Card title="错误类别分布" description="用于判断「是该补规则，还是该补词汇」">
        <ul className="grid grid-cols-2 gap-1.5 md:grid-cols-3">
          {stats.byCategory.map((item) => (
            <li
              key={item.category}
              className="flex items-center justify-between rounded border border-line bg-white px-2 py-1 text-[11px]"
            >
              <span className="text-ink">{item.label}</span>
              <b className="tabular text-inkMuted">{item.count}</b>
            </li>
          ))}
        </ul>
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
