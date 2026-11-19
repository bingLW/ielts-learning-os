'use client';

/**
 * 语法诊断页主体（T21）。
 *
 * 三态齐备：无数据（引导去新建单元）、筛选无结果（提示清空筛选）、正常列表。
 */

import Link from 'next/link';
import { useState } from 'react';
import {
  EGIU_COLORS,
  EGIU_COLOR_LABEL_ZH,
  STAGE_META,
} from '@/lib/constants';
import type { EgiuColor, EgiuLessonRowDto, ResourceOptionDto, StageCode } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ColorLegend } from '@/components/ui/ColorBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';
import { LessonForm } from './LessonForm';
import { LessonTable } from './LessonTable';

export interface GrammarSummaryProps {
  total: number;
  colors: Record<EgiuColor, number>;
  mastered: number;
  lowFreq: number;
  overdueLessons: number;
  reviewsThisWeek: number;
  today: string;
}

export interface GrammarPageBodyProps {
  rows: EgiuLessonRowDto[];
  summary: GrammarSummaryProps;
  stages: { id: string; nameZh: string; code: string }[];
  resources: ResourceOptionDto[];
  activeStageId: string | null;
  activeStageCode: string | null;
  filter: { stageId: string; color: string; q: string };
}

export function GrammarPageBody({
  rows,
  summary,
  stages,
  resources,
  activeStageId,
  activeStageCode,
  filter,
}: GrammarPageBodyProps) {
  const { toast, show, dismiss } = useToastState();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EgiuLessonRowDto | null>(null);

  const stageMeta = activeStageCode ? STAGE_META[activeStageCode as StageCode] : null;
  const egiuAllowed = stageMeta ? stageMeta.allowedEgiu : false;
  const filtered = filter.stageId !== '' || filter.color !== 'ALL' || filter.q !== '';

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (row: EgiuLessonRowDto) => {
    setEditing(row);
    setFormOpen(true);
  };

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">语法诊断（EGIU）</h1>
          <p className="text-xs text-inkMuted">
            三色判定只在服务端计算 · 复测记录只增不改 · 复习点统一进「复习任务」表
          </p>
        </div>
        {!formOpen && (
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Icon name="plus" size={13} />
            新建单元
          </Button>
        )}
      </header>

      {!egiuAllowed && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          当前阶段为「{stageMeta?.nameZh ?? activeStageCode ?? '未设置'}」，EGIU 三色判定仅在「阶段一 / 阶段二」启用。
          你仍然可以维护单元清单，但录入复测会被拒绝（这是产品规则，不是故障）。
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile
          label="单元总数"
          value={summary.total}
          unit="个"
          hint={`已掌握 ${summary.mastered} · 低频池 ${summary.lowFreq}`}
          scopeNote="按单元去重计数，不是复测记录条数"
        />
        <StatTile
          label="红灯单元"
          value={summary.colors.RED}
          unit="个"
          tone="warn"
          hint={`逾期 ${summary.overdueLessons} 个有未完成复习点`}
        />
        <StatTile
          label="本周复测"
          value={summary.reviewsThisWeek}
          unit="次"
          tone="actual"
          hint="按复测日期统计"
        />
        <StatTile
          label="待复习（今日）"
          value={summary.colors.YELLOW + summary.colors.RED}
          unit="个"
          tone="plan"
          hint="黄灯 + 红灯（绿灯不进结构化复习）"
        />
      </div>

      <Card
        title="三色分布"
        description="每个单元只取最近一次有效判定，不按复测条数统计"
        actions={<ColorLegend counts={summary.colors} />}
      >
        <form method="get" className="grid gap-2 mobile:grid-cols-2 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            阶段
            <select
              name="stageId"
              defaultValue={filter.stageId}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="">全部阶段</option>
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.nameZh}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            三色
            <select
              name="color"
              defaultValue={filter.color}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="ALL">全部</option>
              {EGIU_COLORS.map((color) => (
                <option key={color} value={color}>
                  {EGIU_COLOR_LABEL_ZH[color]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            关键词
            <input
              type="search"
              name="q"
              defaultValue={filter.q}
              placeholder="单元号 / 知识点"
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            />
          </label>
          <div className="flex items-end gap-1.5">
            <Button variant="secondary" size="sm" type="submit">
              筛选
            </Button>
            <Link href="/grammar" className="text-[11px] text-brand underline">
              清空
            </Link>
          </div>
        </form>
      </Card>

      {formOpen && (
        <LessonForm
          key={editing?.id ?? 'new'}
          editing={editing}
          stages={stages}
          resources={resources}
          defaultStageId={editing ? null : activeStageId}
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
            icon="book"
            title="没有符合筛选条件的单元"
            description="换个筛选条件，或直接新建一个单元开始记录。"
            primary={{ label: '清空筛选', href: '/grammar' }}
            secondary={{ label: '新建单元', onClick: openCreate }}
          />
        ) : (
          <EmptyState
            icon="book"
            title="还没有 EGIU 单元"
            description="每个 English Grammar in Use 单元建一条记录；首测（D0）录入后会自动生成 D1/D3/D7 复习点。"
            dependencies={[
              '已在「阶段与验收」初始化 4 个阶段并激活一个',
              '资源库里有语法类主材料（可选，但建议绑定）',
            ]}
            primary={{ label: '新建第一个单元', onClick: openCreate }}
            secondary={{ label: '去资源库', href: '/resources' }}
          />
        )
      ) : (
        <Card
          title={`单元清单（${rows.length}）`}
          description="绿灯不生成结构化复习；黄灯 D1/D3/D7；红灯 D1/D3/D7/D14"
        >
          <LessonTable rows={rows} onEdit={openEdit} onToast={show} />
        </Card>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
