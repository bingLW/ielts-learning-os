'use client';

/**
 * 阶段切换动作（PRD §4.9④⑤）。
 *
 * - 「生成/刷新评审」只产出建议，不切阶段；
 * - 「确认进入下一阶段」必须填确认人与原因；非 Ready 结论时二次确认，
 *   并明确提示这是 User-approved transition（越权确认），证据结论不会被改写；
 * - 「继续保持 / 安排补练 / 先补证据」都是不改阶段状态的出口。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { confirmStageTransitionAction, reviewReadinessAction } from '@/lib/actions/planner';
import { TRANSITION_REASON_MIN_LENGTH } from '@/lib/constants';
import { isReadyOutcome } from '@/lib/domain/readiness';

export function StageSwitchActions({
  stageId,
  asOfDate,
  currentStageCode,
  outcome,
  reviewId,
  stages,
}: {
  stageId: string;
  asOfDate: string;
  currentStageCode: string;
  outcome: string | null;
  reviewId: string | null;
  stages: { code: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [toStageCode, setToStageCode] = useState(stages[0]?.code ?? '');
  const [confirmedBy, setConfirmedBy] = useState('本人');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = isReadyOutcome(outcome);

  const review = () => {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await reviewReadinessAction({ stageId, asOfDate });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(`评审已生成：结论 ${result.data.outcome}。系统只建议，是否切换由你决定。`);
      router.refresh();
    });
  };

  const confirm = () => {
    if (!reviewId) {
      setError('请先生成 readiness 评审，再确认切换');
      return;
    }
    if (reason.trim().length < TRANSITION_REASON_MIN_LENGTH) {
      setError(`切换原因至少 ${TRANSITION_REASON_MIN_LENGTH} 个字`);
      return;
    }
    if (confirmedBy.trim().length === 0) {
      setError('请填写确认人');
      return;
    }
    if (!ready && typeof window !== 'undefined') {
      const ok = window.confirm(
        '系统建议暂不切换：当前结论不是 Ready for review。\n继续将被记录为 User-approved transition（越权确认），且不会改写证据结论。确定继续？',
      );
      if (!ok) return;
    }
    setError(null);
    startTransition(async () => {
      const result = await confirmStageTransitionAction({
        reviewId,
        toStageCode,
        reason,
        confirmedBy,
        note: note || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage('已切换阶段，并写入 append-only 的阶段切换日志。将影响后续计划生成。');
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <Button variant="secondary" size="sm" onClick={review} disabled={pending}>
          {pending ? '处理中…' : reviewId ? '刷新评审' : '生成评审'}
        </Button>
        <Link href="/planner/candidates" className="text-[11px] text-brand underline">
          安排针对性补练 →
        </Link>
        <Link href="/planner/build" className="text-[11px] text-brand underline">
          先补证据 / 回到构建
        </Link>
      </div>

      <div
        data-testid="stage-switch-form"
        className="space-y-1.5 rounded border border-line bg-white px-2.5 py-2"
      >
        <p className="text-[11px] font-medium text-ink">确认进入下一阶段（当前 {currentStageCode}）</p>
        {!ready && (
          <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
            系统建议暂不切换。确认按钮不隐藏也不禁用，但会走二次确认，并记录为
            User-approved transition；证据结论仍是「未就绪」。
          </p>
        )}
        <div className="flex flex-wrap items-end gap-1.5">
          <label htmlFor="to-stage" className="text-[11px] text-inkMuted">
            目标阶段
          </label>
          <select
            id="to-stage"
            value={toStageCode}
            onChange={(event) => setToStageCode(event.target.value)}
            className="rounded border border-line bg-white px-2 py-1 text-[11px] text-ink"
          >
            {stages.map((stage) => (
              <option key={stage.code} value={stage.code}>
                {stage.label}
              </option>
            ))}
          </select>
          <label htmlFor="confirmed-by" className="text-[11px] text-inkMuted">
            确认人
          </label>
          <input
            id="confirmed-by"
            value={confirmedBy}
            onChange={(event) => setConfirmedBy(event.target.value)}
            className="w-24 rounded border border-line bg-white px-2 py-1 text-[11px] text-ink"
          />
        </div>
        <div>
          <label htmlFor="switch-reason" className="text-[11px] text-inkMuted">
            切换原因（至少 {TRANSITION_REASON_MIN_LENGTH} 字）
          </label>
          <textarea
            id="switch-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="mt-0.5 w-full rounded border border-line bg-white px-2 py-1 text-[11px] text-ink"
            rows={2}
          />
        </div>
        <div>
          <label htmlFor="switch-note" className="text-[11px] text-inkMuted">
            备注（可选）
          </label>
          <input
            id="switch-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-0.5 w-full rounded border border-line bg-white px-2 py-1 text-[11px] text-ink"
          />
        </div>
        <Button
          variant={ready ? 'primary' : 'secondary'}
          size="sm"
          onClick={confirm}
          disabled={pending || !reviewId || toStageCode.length === 0}
        >
          {ready ? '确认进入下一阶段' : '确认进入下一阶段（越权确认）'}
        </Button>
      </div>

      {message && (
        <p className="rounded-md border border-green-300 bg-green-50 px-2.5 py-1.5 text-[11px] text-green-800">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}