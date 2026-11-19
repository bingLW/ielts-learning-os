'use client';

/**
 * 句子成分页主体（T27）。
 *
 * 说明栏必须写清「成分与词性是两个独立字段」——这是本页最容易理解错的地方。
 */

import Link from 'next/link';
import { useState } from 'react';
import {
  PATTERN_TAG_LABEL_ZH,
  PATTERN_TAGS,
  PATTERN_TAGS_BY_STAGE,
  SENTENCE_COMPONENT_LABEL_ZH,
} from '@/lib/constants';
import type { PatternTag, SentenceRowDto, SentenceStatsDto, StageCode } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';
import { SentenceEditor } from './SentenceEditor';
import { SentenceList } from './SentenceList';

export interface SentencesPageBodyProps {
  rows: SentenceRowDto[];
  stats: SentenceStatsDto;
  stages: { id: string; nameZh: string }[];
  activeStageId: string | null;
  activeStageCode: string | null;
  filter: { patternTag: PatternTag | 'ALL'; onlyError: boolean; q: string };
}

export function SentencesPageBody({
  rows,
  stats,
  stages,
  activeStageId,
  activeStageCode,
  filter,
}: SentencesPageBodyProps) {
  const { toast, show, dismiss } = useToastState();
  const [editorOpen, setEditorOpen] = useState(false);

  const stageTags = activeStageCode
    ? PATTERN_TAGS_BY_STAGE[activeStageCode as StageCode]
    : PATTERN_TAGS;
  const filtered = filter.patternTag !== 'ALL' || filter.onlyError || filter.q !== '';

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">句子成分</h1>
          <p className="text-xs text-inkMuted">
            「句子成分」与「词性」是两个独立字段：成分取 S/V/O/C/Adverbial，词性取名词/动词/…，
            两者互不推导、互不复用。
          </p>
        </div>
        {!editorOpen && (
          <Button variant="primary" size="sm" onClick={() => setEditorOpen(true)}>
            <Icon name="plus" size={13} />
            分析一个句子
          </Button>
        )}
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile label="已分析句子" value={stats.total} unit="句" />
        <StatTile label="标对" value={stats.correct} unit="句" tone="actual" />
        <StatTile label="标错" value={stats.error} unit="句" tone="warn" />
        <StatTile
          label="主导成分"
          value={
            [...stats.componentCounts].sort((a, b) => b.count - a.count)[0]?.label.split(' ')[0] ??
            '—'
          }
          hint={
            [...stats.componentCounts].sort((a, b) => b.count - a.count)[0]
              ? `${[...stats.componentCounts].sort((a, b) => b.count - a.count)[0].count} 个 token`
              : '暂无标注'
          }
        />
      </div>

      <Card
        title="成分分布"
        description="按 token 计数（一句多 token，不做句子级平均）"
      >
        <ul className="grid grid-cols-2 gap-1.5 md:grid-cols-5">
          {stats.componentCounts.map((item) => (
            <li
              key={item.component}
              className="rounded border border-line bg-white px-2 py-1 text-[11px]"
            >
              <span className="text-ink">{SENTENCE_COMPONENT_LABEL_ZH[item.component]}</span>
              <b className="ml-1 tabular text-inkMuted">{item.count}</b>
            </li>
          ))}
        </ul>
        {stats.patterns.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {stats.patterns.map((item) => (
              <span
                key={item.tag}
                className="rounded border border-line bg-surfaceAlt px-2 py-0.5 text-[11px]"
              >
                {item.label} · {item.count}
              </span>
            ))}
          </div>
        )}
      </Card>

      {editorOpen && (
        <SentenceEditor
          stages={stages}
          defaultStageId={activeStageId}
          stageTags={stageTags}
          onToast={show}
          onDone={() => setEditorOpen(false)}
        />
      )}

      <Card title="筛选" description="全部在服务端过滤">
        <form method="get" className="grid gap-2 mobile:grid-cols-2 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            句型标签
            <select
              name="patternTag"
              defaultValue={filter.patternTag}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="ALL">全部</option>
              {PATTERN_TAGS.map((tag) => (
                <option key={tag} value={tag}>
                  {PATTERN_TAG_LABEL_ZH[tag]}
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
              placeholder="英文句子片段"
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            />
          </label>
          <label className="flex items-end gap-1.5 text-[11px] text-inkMuted">
            <input type="checkbox" name="onlyError" value="1" defaultChecked={filter.onlyError} />
            只看标错
          </label>
          <div className="flex items-end gap-1.5">
            <Button variant="secondary" size="sm" type="submit">
              筛选
            </Button>
            <Link href="/sentences" className="text-[11px] text-brand underline">
              清空
            </Link>
          </div>
        </form>
      </Card>

      {rows.length === 0 ? (
        filtered ? (
          <EmptyState
            icon="quote"
            title="没有符合筛选条件的句子"
            description="换个条件，或清空筛选。"
            primary={{ label: '清空筛选', href: '/sentences' }}
          />
        ) : (
          <EmptyState
            icon="quote"
            title="还没有句子分析记录"
            description="从阅读材料里挑一句读不懂的长句，标出主谓宾和从句成分 —— 比刷语法书更能暴露问题。"
            dependencies={['已激活一个阶段', '有一句真实的英文句子']}
            primary={{ label: '分析第一句', onClick: () => setEditorOpen(true) }}
          />
        )
      ) : (
        <Card title={`句子列表（${rows.length}）`} description="按句子日期倒序；标错必须写原因">
          <SentenceList rows={rows} onToast={show} />
        </Card>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
