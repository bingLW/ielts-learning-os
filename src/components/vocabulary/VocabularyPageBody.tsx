'use client';

/**
 * 词汇页主体（T26）。
 *
 * 三档掌握度必须并列展示 —— 页面上不存在「已掌握 42/60」这种合并口径。
 */

import Link from 'next/link';
import { useState } from 'react';
import { MASTERY_LABEL_ZH, MASTERY_LEVELS } from '@/lib/constants';
import { formatPercent } from '@/lib/format';
import type {
  MasteryLevel,
  VocabQuizDto,
  VocabStatsDto,
  VocabWordRowDto,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';
import { QuizPanel } from './QuizPanel';
import { VocabForm } from './VocabForm';
import { VocabTable } from './VocabTable';

export interface VocabularyPageBodyProps {
  rows: VocabWordRowDto[];
  stats: VocabStatsDto;
  quizzes: VocabQuizDto[];
  candidates: VocabWordRowDto[];
  quizDoneToday: boolean;
  weights: { level: MasteryLevel; label: string; weight: number }[];
  filter: { mastery: MasteryLevel | 'ALL'; q: string };
}

export function VocabularyPageBody({
  rows,
  stats,
  quizzes,
  candidates,
  quizDoneToday,
  weights,
  filter,
}: VocabularyPageBodyProps) {
  const { toast, show, dismiss } = useToastState();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<VocabWordRowDto | null>(null);
  const [quizOpen, setQuizOpen] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (row: VocabWordRowDto) => {
    setEditing(row);
    setFormOpen(true);
  };

  const filtered = filter.mastery !== 'ALL' || filter.q !== '';

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">词汇</h1>
          <p className="text-xs text-inkMuted">
            三档掌握度独立统计 · 抽测会话 append-only · 新词量按上周抽测自动建议
          </p>
        </div>
        <div className="flex gap-1.5">
          {!formOpen && (
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Icon name="plus" size={13} />
              新增单词
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setQuizOpen((open) => !open)}>
            {quizOpen ? '收起抽测' : '开始随机抽测'}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile label="词汇总量" value={stats.total} unit="个" scopeNote="不含已归档" />
        <StatTile label="认识但不能用" value={stats.recognizeOnly} unit="个" tone="warn" />
        <StatTile label="能理解" value={stats.comprehend} unit="个" tone="plan" />
        <StatTile label="能主动使用" value={stats.activeUse} unit="个" tone="mastery" />
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile label="本周新词" value={stats.newThisWeek} unit="个" tone="actual" />
        <StatTile label="今日待复习" value={stats.reviewDueToday} unit="个" tone="plan" />
        <StatTile
          label="最近抽测加权正确率"
          value={formatPercent(stats.quizAccuracy, 1)}
          tone="output"
          hint={`共 ${stats.quizCount} 次抽测`}
        />
        <StatTile
          label="下周建议新词量"
          value={stats.suggestedNewWords}
          unit="个/天"
          tone="neutral"
          hint={stats.suggestionReason}
        />
      </div>

      <Card title="筛选" description="掌握度按单档过滤，不做「已掌握 / 未掌握」二分">
        <form method="get" className="grid gap-2 mobile:grid-cols-2 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            掌握度
            <select
              name="mastery"
              defaultValue={filter.mastery}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="ALL">全部</option>
              {MASTERY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {MASTERY_LABEL_ZH[level]}
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
              placeholder="单词 / 释义 / 搭配"
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            />
          </label>
          <div className="flex items-end gap-1.5">
            <Button variant="secondary" size="sm" type="submit">
              筛选
            </Button>
            <Link href="/vocabulary" className="text-[11px] text-brand underline">
              清空
            </Link>
          </div>
        </form>
      </Card>

      {quizOpen && (
        <QuizPanel
          candidates={candidates}
          weights={weights}
          quizDoneToday={quizDoneToday}
          onToast={show}
          onDone={() => setQuizOpen(false)}
        />
      )}

      {formOpen && (
        <VocabForm
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
        filtered ? (
          <EmptyState
            icon="type"
            title="没有符合筛选条件的单词"
            description="换个条件，或清空筛选。"
            primary={{ label: '清空筛选', href: '/vocabulary' }}
          />
        ) : (
          <EmptyState
            icon="type"
            title="词汇表还是空的"
            description="建议每天 15–25 个新词。新词量会根据上周抽测的加权正确率自动调整（<80% 降到 12，≥90% 可升到 22）。"
            dependencies={['有稳定的每日学习时长（设置页）', '至少每周抽测一次']}
            primary={{ label: '新增第一个单词', onClick: openCreate }}
          />
        )
      ) : (
        <Card title={`词汇清单（${rows.length}）`} description="掌握度可随时调整，抽测会按自评写回">
          <VocabTable rows={rows} onEdit={openEdit} onToast={show} />
        </Card>
      )}

      <Card title="抽测历史" description="每次抽测都是新的一条会话，永不覆盖历史">
        {quizzes.length === 0 ? (
          <p className="py-3 text-center text-xs text-inkMuted">还没有抽测记录。</p>
        ) : (
          <ul className="space-y-1.5">
            {quizzes.map((quiz) => (
              <li key={quiz.id} className="rounded border border-line bg-white px-2.5 py-1.5 text-[11px]">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="font-medium text-ink">
                    {quiz.quizDate} · 样本 {quiz.sampleSize} 个
                  </span>
                  <span className="tabular text-inkMuted">
                    加权正确率 {formatPercent(quiz.weightedAccuracy, 1)}
                  </span>
                </div>
                {quiz.recommendation && (
                  <p className="mt-0.5 text-inkMuted">{quiz.recommendation}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
