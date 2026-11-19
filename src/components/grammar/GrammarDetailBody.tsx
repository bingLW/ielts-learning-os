'use client';

/**
 * EGIU 单元详情主体（T21 / T22 / T23）。
 *
 * 结构顺序刻意固定：
 * 当前态 → 掌握度变化 → 待复习点 → 录入复测 → 复测历史。
 * 让人先看到「现在什么水平」，再决定「这次怎么测」。
 */

import Link from 'next/link';
import { useState } from 'react';
import { MASTERY_GREEN_STREAK, MASTERY_MIN_GAP_DAYS, STAGE_META } from '@/lib/constants';
import type { EgiuLessonDetailDto, ReviewStageCode } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { ColorBadge } from '@/components/ui/ColorBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatTile } from '@/components/ui/StatTile';
import { TagBadge } from '@/components/ui/StatusBadge';
import { Toast, useToastState } from '@/components/ui/Toast';
import { MasteryTimeline } from './MasteryTimeline';
import { ReviewEntryForm } from './ReviewEntryForm';
import { ReviewTimeline } from './ReviewTimeline';

export function GrammarDetailBody({ detail }: { detail: EgiuLessonDetailDto }) {
  const { toast, show, dismiss } = useToastState();
  const { lesson } = detail;

  const nextStage: ReviewStageCode =
    (detail.upcoming[0]?.intervalCode as ReviewStageCode | undefined) ??
    (detail.reviews.length === 0 ? 'D0' : 'MANUAL');

  const [entryOpen, setEntryOpen] = useState(detail.reviews.length === 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link href="/grammar" className="text-[11px] text-brand hover:underline">
            ← 返回语法诊断
          </Link>
          <h1 className="mt-0.5 text-base font-semibold text-ink">
            {lesson.book} U{lesson.unitNo} · {lesson.knowledgePoint}
          </h1>
          <p className="text-xs text-inkMuted">
            D0 首测日 {lesson.learnedDate}
            {lesson.version ? ` · 版本 ${lesson.version}` : ''}
            {lesson.resourceName ? ` · 资源 ${lesson.resourceName}` : ''}
          </p>
        </div>
        <ColorBadge color={lesson.currentColor} score={lesson.currentScore} />
      </div>

      {!detail.egiuAllowed && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          当前阶段不启用 EGIU 判定（仅「
          {STAGE_META.S1_A0_A2.nameZh}」与「{STAGE_META.S2_A2_B1.nameZh}」）。复测录入会被拒绝。
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile label="复测次数" value={lesson.retestCount} unit="次" tone="actual" />
        <StatTile
          label="连续绿灯"
          value={lesson.greenStreak}
          unit="次"
          tone="mastery"
          hint={`需 ${MASTERY_GREEN_STREAK} 次且间隔 ≥${MASTERY_MIN_GAP_DAYS} 天`}
        />
        <StatTile
          label="待复习点"
          value={detail.upcoming.length}
          unit="条"
          tone="plan"
          hint={`逾期 ${lesson.overdueReviewCount} 条`}
        />
        <StatTile
          label="下次复习"
          value={lesson.nextReviewDate ?? '—'}
          tone="plan"
          hint={lesson.inLowFreqPool ? '已在 30 天低频池' : undefined}
        />
      </div>

      <Card title="当前判定依据" description="这一行是服务端判定的原文，不接受手工改写">
        <p className="text-xs text-ink">
          {lesson.currentReason ?? '尚未录入任何复测，暂未判定'}
        </p>
        <p className="mt-1 text-[11px] text-inkMuted">{detail.masteryNote}</p>
        {lesson.mastered && (
          <div className="mt-1.5">
            <TagBadge tone="info">
              已掌握{lesson.masteredAt ? ` · ${lesson.masteredAt.slice(0, 10)}` : ''}
              {lesson.inLowFreqPool ? ' · 30 天低频抽测' : ''}
            </TagBadge>
          </div>
        )}
      </Card>

      <Card title="掌握度变化" description="每次颜色迁移都会留痕；绿灯连续 2 次且间隔 ≥7 天才算掌握">
        <MasteryTimeline changes={detail.masteryChanges} />
      </Card>

      <Card
        title="待复习点"
        description="逾期不会自动改期；完成复习请到「复习中心」或直接在本页录入复测"
        actions={
          <Link href="/review" className="text-[11px] text-brand hover:underline">
            打开复习中心
          </Link>
        }
      >
        {detail.upcoming.length === 0 ? (
          <p className="py-3 text-center text-xs text-inkMuted">
            当前没有未完成的复习点（绿灯不生成结构化复习；掌握后进入 30 天低频池）。
          </p>
        ) : (
          <ul className="space-y-1">
            {detail.upcoming.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center justify-between gap-1 rounded-md border border-line bg-white px-2.5 py-1.5 text-[11px]"
              >
                <span className="text-ink">
                  {task.intervalLabel} · 到期 {task.dueDate}
                </span>
                <span className={task.isOverdue ? 'text-red-700' : 'text-inkMuted'}>
                  {task.isOverdue ? `逾期 ${task.overdueDays} 天` : `预估 ${task.estMinutes} 分钟`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="录入一次复测"
        description="颜色由系统按 PRD §6.1 判定；你只填事实（对了多少题、能不能讲清、造了几句）"
        actions={
          <button
            type="button"
            onClick={() => setEntryOpen((open) => !open)}
            className="rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink"
          >
            {entryOpen ? '收起' : '展开'}
          </button>
        }
      >
        {entryOpen ? (
          <ReviewEntryForm
            lessonId={lesson.id}
            defaultStage={nextStage}
            disabled={!detail.egiuAllowed}
            onToast={show}
          />
        ) : (
          <p className="py-2 text-center text-[11px] text-inkMuted">
            已收起。展开后可录入首测（D0）或任意档位复测。
          </p>
        )}
      </Card>

      <Card title={`复测历史（${detail.reviews.length}）`} description="append-only：只增不改，录入错误也只能追加更正记录">
        {detail.reviews.length === 0 ? (
          <EmptyState
            icon="repeat"
            title="还没有复测记录"
            description="先录入首测（D0）。判定为黄灯会生成 D1/D3/D7，红灯再多一个 D14。"
            primary={{ label: '录入首测', onClick: () => setEntryOpen(true) }}
          />
        ) : (
          <ReviewTimeline reviews={detail.reviews} />
        )}
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
