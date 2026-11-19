'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  VOCAB_DIMENSIONS,
  VOCAB_DIMENSION_LABEL_ZH,
  type VocabDimension,
} from '@/lib/constants';
import { createVocabEvidenceAction } from '@/lib/actions/vocabIntegration';
import { Button } from '@/components/ui/Button';
import { Toast, useToastState } from '@/components/ui/Toast';

export function VocabEvidenceForm({ itemId }: { itemId: string }) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [dimension, setDimension] = useState<VocabDimension>('MEANING_RECALL');
  const [level, setLevel] = useState<'QUICK' | 'STANDARD' | 'FULL'>('STANDARD');
  const [score, setScore] = useState('2');
  const [typedInput, setTypedInput] = useState('');
  const [scoreReason, setScoreReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const result = await createVocabEvidenceAction({
      itemId,
      dimension,
      level,
      score: Number(score),
      typedInput: typedInput || undefined,
      scoreReason: scoreReason || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      show(result.error, 'error');
      return;
    }
    show(`证据已记录 · 维度推进到 ${result.data.status}`);
    setTypedInput('');
    setScoreReason('');
    router.refresh();
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-2 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
          维度
          <select
            value={dimension}
            onChange={(event) => setDimension(event.target.value as VocabDimension)}
            className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
          >
            {VOCAB_DIMENSIONS.map((item) => (
              <option key={item} value={item}>
                {VOCAB_DIMENSION_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
          级别
          <select
            value={level}
            onChange={(event) => setLevel(event.target.value as 'QUICK' | 'STANDARD' | 'FULL')}
            className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
          >
            <option value="QUICK">QUICK（快速）</option>
            <option value="STANDARD">STANDARD（标准）</option>
            <option value="FULL">FULL（完整）</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
          自评（0 无证据 / 1 部分 / 2 独立完成）
          <select
            value={score}
            onChange={(event) => setScore(event.target.value)}
            className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
          >
            <option value="0">0</option>
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
        你的产出（拼写 / 造句 / 解释，可选）
        <textarea
          value={typedInput}
          onChange={(event) => setTypedInput(event.target.value)}
          rows={2}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
        评分理由（可选）
        <input
          value={scoreReason}
          onChange={(event) => setScoreReason(event.target.value)}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
        />
      </label>
      <p className="text-[11px] text-inkMuted">
        规则：score 2 且级别不是 QUICK → APPLIED_TASK（E4）；其余 → ASSISTED（E1/E2）。
        语境理解至少 E2，产出使用至少 E4，否则不会推进。
      </p>
      <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
        记录证据并推进维度
      </Button>
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
