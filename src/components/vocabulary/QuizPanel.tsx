'use client';

/**
 * 随机抽测面板（T26）。
 *
 * 自评只用三档（对应权重 1.0 / 0.7 / 0.3）；提交后：
 * - 写入一条新的 `VocabQuiz` + N 条 `VocabQuizItem`（append-only）；
 * - 按自评写回单词的 `mastery`；
 * - 为抽测过的单词追加 D7 复习点（统一复习调度）。
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { submitVocabQuizAction } from '@/lib/actions/vocab';
import { MASTERY_LABEL_ZH, MASTERY_LEVELS, QUIZ_PASS, QUIZ_SIZE } from '@/lib/constants';
import { today } from '@/lib/date';
import { formatPercent } from '@/lib/format';
import type { MasteryLevel, VocabWordRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

export interface QuizPanelProps {
  candidates: VocabWordRowDto[];
  weights: { level: MasteryLevel; label: string; weight: number }[];
  quizDoneToday: boolean;
  onToast: (message: string, tone: 'success' | 'error') => void;
  onDone: () => void;
}

export function QuizPanel({ candidates, weights, quizDoneToday, onToast, onDone }: QuizPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [ratings, setRatings] = useState<Record<string, MasteryLevel>>({});
  const [result, setResult] = useState<{
    sampleSize: number;
    weightedAccuracy: number | null;
    recommendation: string;
    passed: boolean;
  } | null>(null);

  const answered = useMemo(() => Object.keys(ratings).length, [ratings]);

  const setRating = (wordId: string, level: MasteryLevel) => {
    setRatings((current) => ({ ...current, [wordId]: level }));
  };

  const submit = () => {
    const answers = Object.entries(ratings).map(([wordId, selfRating]) => ({ wordId, selfRating }));
    if (answers.length === 0) {
      onToast('至少自评一个单词再提交', 'error');
      return;
    }
    startTransition(async () => {
      const response = await submitVocabQuizAction({ quizDate: today(), answers });
      if (!response.ok) {
        onToast(response.error, 'error');
        return;
      }
      setResult({
        sampleSize: response.data.sampleSize,
        weightedAccuracy: response.data.weightedAccuracy,
        recommendation: response.data.recommendation,
        passed: response.data.passed,
      });
      onToast(`抽测已记录：${response.data.sampleSize} 个单词`, 'success');
      setRatings({});
      router.refresh();
    });
  };

  if (candidates.length === 0) {
    return (
      <Card title="随机抽测" description="从当前词汇表随机取样">
        <EmptyState
          icon="type"
          title="词汇表为空，无法抽测"
          description="先添加单词，再回来抽测。"
          primary={{ label: '关闭', onClick: onDone }}
        />
      </Card>
    );
  }

  return (
    <Card
      title={`随机抽测（样本 ${candidates.length} 个，建议 ${QUIZ_SIZE.MIN}–${QUIZ_SIZE.MAX}）`}
      description={`自评三档对应权重：${weights
        .map((item) => `${item.label} ${item.weight}`)
        .join(' / ')}；通过线 ${formatPercent(QUIZ_PASS)}`}
      actions={
        <span className="text-[11px] text-inkMuted">
          {quizDoneToday ? '今天已抽测过，可再测一次' : '今天还没抽测'}
        </span>
      }
    >
      {result && (
        <div className="mb-2 rounded-md border border-line bg-surfaceAlt px-3 py-2 text-[11px]">
          <p className="font-medium text-ink">
            本次加权正确率 {formatPercent(result.weightedAccuracy, 1)} ·{' '}
            {result.passed ? '达标' : '未达标'} · 样本 {result.sampleSize} 个
          </p>
          <p className="mt-0.5 text-inkMuted">{result.recommendation}</p>
        </div>
      )}

      <div className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
        {candidates.map((word) => (
          <div
            key={word.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-line bg-white px-2.5 py-1.5"
          >
            <div className="min-w-0">
              <p className="text-xs font-medium text-ink">
                {word.word}
                {word.phonetic && (
                  <span className="ml-1 text-[10px] font-normal text-inkMuted">{word.phonetic}</span>
                )}
              </p>
              <p className="text-[11px] text-inkMuted">{word.meaningZh}</p>
            </div>
            <div className="flex gap-1">
              {MASTERY_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setRating(word.id, level)}
                  aria-pressed={ratings[word.id] === level}
                  className={[
                    'rounded border px-2 py-1 text-[11px]',
                    ratings[word.id] === level
                      ? 'border-brand bg-brand text-white'
                      : 'border-line bg-white text-ink hover:bg-surfaceAlt',
                  ].join(' ')}
                >
                  {MASTERY_LABEL_ZH[level]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '提交中…' : `提交抽测（已评 ${answered} 个）`}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setRatings({})}>
          清空自评
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          收起
        </Button>
      </div>
    </Card>
  );
}
