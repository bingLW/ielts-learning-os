/**
 * `/vocabulary/words/[id]` 单词详情：七维状态 + 最近证据 + 快速记证据。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  VOCAB_DIMENSION_LABEL_ZH,
  VOCAB_DIMENSION_STATUS_LABEL_ZH,
  type VocabDimension,
  type VocabDimensionStatus,
} from '@/lib/constants';
import { getBusinessTimezone } from '@/lib/businessTime';
import { formatBusinessDateTime, toBusinessDate } from '@/lib/date';
import { getVocabWordDetail } from '@/lib/queries/vocabIntegration';
import { listVocabRetests } from '@/lib/vocabRetest';
import { Card } from '@/components/ui/Card';
import { VocabEvidenceForm } from '@/components/vocabulary/VocabEvidenceForm';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function VocabularyWordPage({ params }: PageProps) {
  const { id } = await params;
  const word = await getVocabWordDetail(id);
  if (!word) notFound();
  const retests = await listVocabRetests(word.id);
  const timeZone = await getBusinessTimezone();
  const retestDimension = (note: string | null): string => {
    const parts = (note ?? '').split('|');
    const dimension = parts[2] ?? '';
    return VOCAB_DIMENSION_LABEL_ZH[dimension as VocabDimension] ?? (dimension || '—');
  };

  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-lg font-semibold text-ink">{word.lemma}</h1>
          {word.pos && <span className="text-xs text-inkMuted">{word.pos}</span>}
          <span className="text-[11px] text-inkMuted">senseKey: {word.senseKey}</span>
        </div>
        <p className="text-xs text-inkMuted">
          来源 {word.sourceTitle ?? '—'}（{word.sourceType}）
          <Link href="/vocabulary/library" className="ml-2 text-brand underline">
            返回词库
          </Link>
        </p>
      </header>

      <Card title="释义" description="词条按 lemma + pos + senseKey 唯一">
        <p className="text-sm text-ink">{word.definitionZh ?? '（无中文释义）'}</p>
        {word.definitionEn && <p className="mt-1 text-xs text-inkMuted">{word.definitionEn}</p>}
        {(word.phoneticUk || word.phoneticUs) && (
          <p className="mt-1 text-[11px] text-inkMuted">
            {word.phoneticUk ? `英 ${word.phoneticUk}` : ''}
            {word.phoneticUs ? ` · 美 ${word.phoneticUs}` : ''}
          </p>
        )}
        {word.examples.length > 0 && (
          <ul className="mt-2 list-disc pl-4 text-[11px] text-inkMuted">
            {word.examples.slice(0, 5).map((example) => (
              <li key={example}>{example}</li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="七维掌握" description="互不合并；每维有自己的状态与证据数">
        <div className="grid gap-2 md:grid-cols-2">
          {word.dimensions.map((dimension) => (
            <div key={dimension.dimension} className="rounded border border-line bg-white px-2.5 py-2 text-[11px]">
              <p className="font-medium text-ink">
                {VOCAB_DIMENSION_LABEL_ZH[dimension.dimension as VocabDimension] ?? dimension.dimension}
              </p>
              <p className="text-inkMuted">
                {VOCAB_DIMENSION_STATUS_LABEL_ZH[dimension.status as VocabDimensionStatus] ?? dimension.status}
                {' · '}置信度 {dimension.confidence}
                {' · '}证据 {dimension.evidenceCount}
                {dimension.lastVerifiedAt ? ` · 最近 ${dimension.lastVerifiedAt}` : ''}
              </p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="记录一条词汇证据" description="证据写入统一 EvidenceRecord，并链接到该词条与该维度">
        <VocabEvidenceForm itemId={word.id} />
      </Card>

      <Card
        title="延迟复测"
        description="维度到「能回忆」后自动排 1 / 7 / 30 天复测；到期后再记一条同维度证据即结清"
      >
        {retests.length === 0 ? (
          <p className="text-xs text-inkMuted">
            还没有复测排期。维度达到「能回忆」及以上时自动生成。
          </p>
        ) : (
          <ul className="space-y-1 text-[11px]">
            {retests.map((retest) => (
              <li
                key={retest.id}
                className="flex flex-wrap items-center justify-between gap-1 border-b border-line pb-1 last:border-b-0"
              >
                <span className="text-ink">
                  {retestDimension(retest.note)} · {retest.retestType}
                </span>
                <span className="tabular text-inkMuted">
                  {retest.dueDate} · {retest.status}
                  {retest.completedAt ? ` · 完成于 ${toBusinessDate(retest.completedAt, timeZone)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="最近证据" description="每条证据只推进一个维度">
        {word.recentEvidence.length === 0 ? (
          <p className="text-xs text-inkMuted">还没有词汇证据。</p>
        ) : (
          <ul className="space-y-1 text-[11px]">
            {word.recentEvidence.map((evidence) => (
              <li key={evidence.id} className="flex flex-wrap items-center justify-between gap-1 border-b border-line pb-1 last:border-b-0">
                <span className="text-ink">
                  {VOCAB_DIMENSION_LABEL_ZH[evidence.dimension as VocabDimension] ?? evidence.dimension}
                </span>
                <span className="tabular text-inkMuted">
                  {evidence.businessDate} · {evidence.evidenceType} · {evidence.level}
                  {evidence.score !== null ? ` · 分 ${evidence.score}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="最近练习会话" description="仅在源文件提供逐词尝试时才有会话关联">
        {word.recentSessions.length === 0 ? (
          <p className="text-xs text-inkMuted">没有逐词会话记录（TypeWords 备份只提供汇总统计）。</p>
        ) : (
          <ul className="space-y-1 text-[11px]">
            {word.recentSessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between">
                <span className="text-ink">{formatBusinessDateTime(session.startedAt, timeZone)}</span>
                <span className="tabular text-inkMuted">
                  {Math.round(session.effectiveSeconds / 60)} 分钟 · {session.granularity}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
