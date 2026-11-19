/**
 * `/vocabulary` v2.3 词汇引擎概览。
 *
 * 七维掌握分开显示，不合并成「已掌握 N 个」；
 * 时长与会话只来自 VocabularyPracticeSession（对应的 StudySession 才是净时长载体）。
 */

import Link from 'next/link';
import {
  TYPEWORDS_KNOWN_LIMITS_ZH,
  TYPEWORDS_PINNED_COMMIT,
  TYPEWORDS_PINNED_DATE,
  VOCAB_DIMENSION_LABEL_ZH,
} from '@/lib/constants';
import { formatBusinessDateTime, today } from '@/lib/date';
import {
  getVocabAssignment,
  getVocabLibraryStats,
  listRecentSessions,
} from '@/lib/queries/vocabIntegration';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatTile } from '@/components/ui/StatTile';
import { buttonClass } from '@/components/ui/Button';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/vocabulary/library', label: '词库与导入' },
  { href: '/vocabulary/today', label: '今日词汇任务' },
  { href: '/vocabulary/sync', label: '数据交换' },
  { href: '/vocabulary/connection', label: '连接与版本' },
  { href: '/vocabulary/analytics', label: '词汇分析' },
  { href: '/vocabulary/legacy', label: '旧版词汇表（v2.1）' },
];

function formatTime(iso: string | null): string {
  return iso ? formatBusinessDateTime(iso) : '—';
}

export default async function VocabularyPage() {
  const date = today();
  const [stats, assignment, sessions] = await Promise.all([
    getVocabLibraryStats(),
    getVocabAssignment(date),
    listRecentSessions(8),
  ]);

  return (
    <div className="space-y-3">
      <header className="space-y-2">
        <div>
          <h1 className="text-base font-semibold text-ink">词汇引擎（v2.3）</h1>
          <p className="text-xs text-inkMuted">
            OS 负责计划、词库、证据与报表；TypeWords 固定版本负责练习。两边通过文件交换，
            单词的「已掌握」不会被当成 OS 的七维掌握。
          </p>
        </div>
        <nav className="flex flex-wrap gap-1.5">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={buttonClass('secondary', 'sm')}>
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile label="词条总量" value={stats.items} unit="个" scopeNote="按 lemma + pos + senseKey 计" />
        <StatTile label="词库" value={stats.decks} unit="个" tone="plan" />
        <StatTile label="到期未复习维度" value={stats.dueReview} unit="条" tone="warn" hint="昨天以前最后验证" />
        <StatTile label="今日新词条" value={stats.introducedToday} unit="个" tone="actual" />
      </div>

      <Card title="七维掌握（分开统计）" description="每个维度独立推进；识别类最高到「能回忆」，语境理解与产出使用需要更强证据">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {stats.dimensionVerified &&
            Object.entries(stats.dimensionVerified).map(([dimension, count]) => (
              <div key={dimension} className="rounded border border-line bg-white px-2.5 py-2">
                <p className="text-[11px] text-inkMuted">
                  {VOCAB_DIMENSION_LABEL_ZH[dimension as keyof typeof VOCAB_DIMENSION_LABEL_ZH] ?? dimension}
                </p>
                <p className="tabular mt-0.5 text-sm font-semibold text-ink">{count}</p>
              </div>
            ))}
        </div>
      </Card>

      <div className="grid gap-2 lg:grid-cols-2">
        <Card
          title="今日词汇任务"
          description={assignment ? `${assignment.assignmentDate} · ${assignment.status}` : '当日还没有词汇任务'}
          actions={
            <Link href="/vocabulary/today" className={buttonClass('secondary', 'sm')}>
              查看
            </Link>
          }
        >
          {assignment ? (
            <div className="space-y-1.5 text-xs text-inkMuted">
              <p>
                预算 {assignment.budgetMinutes} 分钟 · 复习 {assignment.reviewTarget} · 新词{' '}
                {assignment.newTarget} · 预计 {assignment.estimatedMinutes} 分钟
              </p>
              <p>词库：{assignment.deckTitle ?? '未关联'}</p>
              <p>任务条目：{assignment.items.length} 个（按 P0–P3 排序）</p>
              {assignment.rationale && <p className="text-ink">{assignment.rationale}</p>}
            </div>
          ) : (
            <p className="text-xs text-inkMuted">
              在「今日词汇任务」页可以按当日计划里的 VOCAB_REVIEW 分钟数补生成。
            </p>
          )}
        </Card>

        <Card title="最近练习会话" description="汇总统计来自 TypeWords 备份；逐词尝试只在源文件真实提供时才有">
          {sessions.length === 0 ? (
            <p className="text-xs text-inkMuted">还没有导入任何练习会话。</p>
          ) : (
            <ul className="space-y-1">
              {sessions.map((session) => (
                <li key={session.id} className="flex flex-wrap items-center justify-between gap-1 border-b border-line pb-1 text-[11px] last:border-b-0">
                  <span className="text-ink">{formatTime(session.startedAt)}</span>
                  <span className="tabular text-inkMuted">
                    {Math.round(session.effectiveSeconds / 60)} 分钟 · {session.granularity}
                    {session.overlapAdjusted ? ' · 已扣重叠' : ''}
                    {session.correctCount !== null ? ` · 对 ${session.correctCount}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="TypeWords 固定版本" description="所有解析与字段映射都按这个 commit 审计，不用 latest">
        <ul className="space-y-1 text-[11px] text-inkMuted">
          <li>commit：{TYPEWORDS_PINNED_COMMIT}（{TYPEWORDS_PINNED_DATE}）</li>
          <li>许可：GPL-3.0（仅文件交换，不修改、不分发其代码）</li>
          <li>最近导入来源：{stats.lastImportAt ? formatTime(stats.lastImportAt) : '—'}</li>
          <li>最近练习：{stats.lastSessionAt ? formatTime(stats.lastSessionAt) : '—'}</li>
        </ul>
      </Card>

      <Card title="已知限制" description="迁移前先看，避免把外部状态误当成本地掌握">
        <ul className="list-disc space-y-1 pl-4 text-[11px] text-inkMuted">
          {TYPEWORDS_KNOWN_LIMITS_ZH.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </Card>

      {stats.items === 0 && (
        <EmptyState
          icon="type"
          title="词库还是空的"
          description="先导入 CSV / TSV / JSON 词表，或从 TypeWords 备份里提取单词。"
          primary={{ label: '去导入词库', href: '/vocabulary/library' }}
          secondary={{ label: '导入 TypeWords 备份', href: '/vocabulary/sync' }}
        />
      )}
    </div>
  );
}
