'use client';

import Link from 'next/link';
import { useState } from 'react';
import { exportVocabDeckAction } from '@/lib/actions/vocabIntegration';
import { generateVocabAssignmentAction } from '@/lib/actions/vocabIntegration';
import type { VocabAssignmentDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Toast, useToastState } from '@/components/ui/Toast';

const KIND_LABEL: Record<string, string> = {
  REVIEW: '复习',
  NEW: '新词',
  WEAKNESS: '弱项',
};

export interface VocabTodayBodyProps {
  date: string;
  assignment: VocabAssignmentDto | null;
  activeDeckId: string | null;
  planMinutes: number | null;
}

export function VocabTodayBody({ date, assignment, activeDeckId, planMinutes }: VocabTodayBodyProps) {
  const { toast, show, dismiss } = useToastState();
  const [busy, setBusy] = useState(false);

  const runGenerate = async () => {
    setBusy(true);
    const result = await generateVocabAssignmentAction({ assignmentDate: date });
    setBusy(false);
    if (!result.ok) {
      show(result.error, 'error');
      return;
    }
    show(`已生成：复习 ${result.data.reviewTarget} · 新词 ${result.data.newTarget}`);
    result.data.warnings.forEach((warning) => show(warning, 'info'));
  };

  const runExport = async () => {
    const deckId = assignment?.deckId ?? activeDeckId;
    if (!deckId) {
      show('还没有可导出的词库', 'error');
      return;
    }
    setBusy(true);
    const result = await exportVocabDeckAction({ deckId });
    setBusy(false);
    if (!result.ok) {
      show(result.error, 'error');
      return;
    }
    const blob = new Blob([result.data.text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.data.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    show(
      `已导出 ${result.data.wordCount} 个词${result.data.assignmentMarkedSent ? '，今日任务标记为已发送' : ''}`,
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={runGenerate} disabled={busy || !!assignment}>
          {assignment ? '今日已生成' : '按计划分钟数生成今日词汇任务'}
        </Button>
        <Button variant="secondary" size="sm" onClick={runExport} disabled={busy}>
          导出 TypeWords 兼容包
        </Button>
        <span className="text-[11px] text-inkMuted">
          计划里的词汇分钟数：{planMinutes ?? '—'} 分钟
        </span>
      </div>

      {assignment ? (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            <div className="rounded border border-line bg-white p-2.5">
              <p className="text-[11px] text-inkMuted">预算</p>
              <p className="tabular font-semibold text-ink">{assignment.budgetMinutes} 分钟</p>
            </div>
            <div className="rounded border border-line bg-white p-2.5">
              <p className="text-[11px] text-inkMuted">复习 / 新词</p>
              <p className="tabular font-semibold text-ink">
                {assignment.reviewTarget} / {assignment.newTarget}
              </p>
            </div>
            <div className="rounded border border-line bg-white p-2.5">
              <p className="text-[11px] text-inkMuted">预计用时</p>
              <p className="tabular font-semibold text-ink">{assignment.estimatedMinutes} 分钟</p>
            </div>
            <div className="rounded border border-line bg-white p-2.5">
              <p className="text-[11px] text-inkMuted">状态</p>
              <p className="font-semibold text-ink">{assignment.status}</p>
            </div>
          </div>

          <Card
            title={`任务条目（${assignment.items.length}）`}
            description={assignment.rationale ?? '按 P0–P3 排序；先复习、再弱项、最后新词'}
          >
            {assignment.items.length === 0 ? (
              <p className="text-xs text-inkMuted">
                候选不足：词库为空，或所有词都已安排过。先导入词表再生成。
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {assignment.items.map((item) => (
                  <li key={item.itemId} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                    <div>
                      <Link href={`/vocabulary/words/${item.itemId}`} className="text-brand underline">
                        {item.lemma}
                      </Link>
                      {item.pos && <span className="ml-1 text-inkMuted">({item.pos})</span>}
                      {item.definitionZh && (
                        <span className="ml-2 text-inkMuted">{item.definitionZh}</span>
                      )}
                    </div>
                    <span className="tabular shrink-0 text-[11px] text-inkMuted">
                      {item.priority} · {KIND_LABEL[item.kind] ?? item.kind}
                      {item.mode ? ` · ${item.mode}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : (
        <Card title="今天还没有词汇任务">
          <p className="text-xs text-inkMuted">
            {date} 的计划里没有可用的 VOCAB_REVIEW 分钟数，或尚未生成计划。先到
            <Link href="/plan" className="mx-1 text-brand underline">
              学习计划
            </Link>
            生成当日计划，再回到这里。
          </p>
        </Card>
      )}

      <p className="text-[11px] text-inkMuted">
        导入 TypeWords 备份时，官方导入会整库覆盖对方词库；导出前请让对方先备份原数据。
      </p>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
