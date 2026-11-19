'use client';

/**
 * 90 天周期页主体。
 *
 * 结构：周期进度 → 阶段门槛与推进 → 中断恢复 → 每周主问题（13 周）→ 历史周期。
 * 所有数值阈值来自 constants，判定来自 domain/cycle；页面只负责展示与调用 action。
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  advanceCyclePhaseAction,
  completeCycleAction,
  createCycleAction,
  pauseCycleAction,
  resumeCycleAction,
  saveRecoveryNoteAction,
  upsertWeeklyFocusAction,
} from '@/lib/actions/cycle';
import {
  CYCLE_BUILD_MIN_COMPARABLE_OUTPUTS,
  CYCLE_COMPARABLE_NOTE_ZH,
  CYCLE_FOCUS_NOTE_ZH,
  CYCLE_NO_BACKLOG_NOTE_ZH,
  CYCLE_PHASE_ADVICE_ZH,
  CYCLE_PHASE_GATE_NOTE_ZH,
  CYCLE_PHASE_LABEL_ZH,
  CYCLE_PHASES,
  CYCLE_RECOVERY_NOTE_ZH,
  CYCLE_STATUS_LABEL_ZH,
  CYCLE_TOTAL_DAYS,
  CYCLE_WEEKS,
  EVIDENCE_SKILL_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
  WEEKLY_FOCUS_SLOT_LABEL_ZH,
  WEEKLY_FOCUS_STATUS_LABEL_ZH,
  WEEKLY_REVIEW_MINUTES,
} from '@/lib/constants';
import { startOfIsoWeek } from '@/lib/date';
import {
  buildRecoveryAdvice,
  canReviewWeeklyFocus,
  checkCycleCompletion,
  checkPhaseAdvance,
  computeCycleProgress,
  cycleWeekIndex,
  cycleWeekStart,
  weeklyFocusFilledSlots,
  weeklyFocusMissingSlots,
} from '@/lib/domain/cycle';
import type {
  ActionResult,
  CycleBoardDto,
  CycleEvidenceOptionDto,
  CyclePhaseCode,
  LearningCycleDto,
  WeeklyFocusDto,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';

export interface CyclePageBodyProps {
  board: CycleBoardDto;
  todayStr: string;
}

type ShowToast = (message: string, tone?: 'success' | 'error' | 'info') => void;

function useRunner(show: ShowToast) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (task: () => Promise<ActionResult<unknown>>, successMessage: string) => {
    startTransition(async () => {
      const result = await task();
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show(successMessage, 'success');
      router.refresh();
    });
  };
  return { pending, run };
}

function statusBadgeClass(status: LearningCycleDto['status']): string {
  if (status === 'COMPLETED') return 'bg-egGreen/15 text-ink';
  if (status === 'PAUSED') return 'bg-egYellow/20 text-ink';
  return 'bg-brand/10 text-brand';
}

export function CyclePageBody({ board, todayStr }: CyclePageBodyProps) {
  const { toast, show, dismiss } = useToastState();

  return (
    <div className="flex flex-col gap-4">
      {board.active ? (
        <ActiveCycleView
          key={board.active.id}
          cycle={board.active}
          board={board}
          todayStr={todayStr}
          show={show}
        />
      ) : (
        <CreateCycleCard todayStr={todayStr} show={show} />
      )}
      <HistoryCard history={board.history} />
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

function CreateCycleCard({ todayStr, show }: { todayStr: string; show: ShowToast }) {
  const { pending, run } = useRunner(show);
  const [title, setTitle] = useState('90 天英语学习周期');
  const [goal, setGoal] = useState('');
  const [deliverable, setDeliverable] = useState('');
  const [startDate, setStartDate] = useState(todayStr);

  return (
    <Card
      title="开启 90 天周期"
      description={`固定 ${CYCLE_TOTAL_DAYS} 天：校准 1–14 天、积累 15–56 天、交付 57–90 天。同时只会有一个进行中的周期。`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="周期标题" required>
          <input
            className={inputClass}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={80}
          />
        </FormField>
        <FormField label="开始日期" required hint="结束时长为开始日期起连续 90 天。">
          <input
            type="date"
            className={inputClass}
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </FormField>
        <FormField
          label="真实学习目标"
          required
          hint="写可验证的目标，例如「能独立完成一篇 250 词 Task 2 并在 40 分钟内自检」。"
          className="sm:col-span-2"
        >
          <textarea
            className={textareaClass}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            maxLength={400}
            placeholder="90 天后，我希望能在真实场景中做到什么？"
          />
        </FormField>
        <FormField
          label="交付物"
          hint="周期结束时可以拿出来验证的成果，例如一份录音、一组文章或一次真实交流。"
          className="sm:col-span-2"
        >
          <input
            className={inputClass}
            value={deliverable}
            onChange={(event) => setDeliverable(event.target.value)}
            maxLength={200}
            placeholder="例如：3 段 2 分钟独立口语录音 + 1 篇 250 词作文"
          />
        </FormField>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[11px] text-inkMuted">
          创建时会自动抓取各技能最新一条基线证据（BASELINE）作为周期起点参照。
        </p>
        <Button
          variant="primary"
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => createCycleAction({ title, goal, deliverable, startDate }),
              '周期已创建：从校准阶段开始',
            )
          }
        >
          {pending ? '创建中…' : '创建周期'}
        </Button>
      </div>
    </Card>
  );
}

interface ActiveCycleViewProps {
  cycle: LearningCycleDto;
  board: CycleBoardDto;
  todayStr: string;
  show: ShowToast;
}

function ActiveCycleView({ cycle, board, todayStr, show }: ActiveCycleViewProps) {
  const { pending, run } = useRunner(show);
  const [confirmComplete, setConfirmComplete] = useState(false);

  const progress = computeCycleProgress(cycle.startDate, todayStr);
  const counts = {
    comparableOutputs: board.comparableOutputs,
    deliveryEvidence: board.deliveryEvidence,
  };
  const phaseStatus: CyclePhaseCode | null =
    cycle.status === 'PAUSED' || cycle.status === 'COMPLETED' ? null : (cycle.status as CyclePhaseCode);
  const advanceGate =
    phaseStatus === 'DELIVER' ? null : phaseStatus ? checkPhaseAdvance(phaseStatus, counts) : null;
  const completionGate = checkCycleCompletion(progress.dayNumber, counts);

  const currentWeek = cycleWeekIndex(cycle.startDate, startOfIsoWeek(todayStr)) ?? 1;
  const [weekIndex, setWeekIndex] = useState(currentWeek);
  const focus = cycle.weeklyFocus.find((item) => item.weekIndex === weekIndex) ?? null;

  const missedWeeks = useMemo(() => {
    let missed = 0;
    for (let week = 1; week < Math.min(currentWeek, CYCLE_WEEKS + 1); week += 1) {
      if (!cycle.weeklyFocus.some((item) => item.weekIndex === week)) missed += 1;
    }
    return missed;
  }, [cycle.weeklyFocus, currentWeek]);

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={
          <span className="flex items-center gap-2">
            {cycle.title}
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${statusBadgeClass(cycle.status)}`}>
              {CYCLE_STATUS_LABEL_ZH[cycle.status]}
            </span>
          </span>
        }
        description={`${cycle.startDate} → ${cycle.endDate} · ${cycle.goal}`}
        actions={
          <>
            {cycle.status === 'PAUSED' ? (
              <Button
                size="sm"
                variant="primary"
                disabled={pending}
                onClick={() => run(() => resumeCycleAction({ cycleId: cycle.id }), '周期已恢复')}
              >
                恢复周期
              </Button>
            ) : cycle.status === 'COMPLETED' ? null : (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => run(() => pauseCycleAction({ cycleId: cycle.id }), '周期已暂停')}
              >
                暂停
              </Button>
            )}
            {cycle.status !== 'COMPLETED' && (
              <Button
                size="sm"
                variant="primary"
                disabled={pending || !completionGate.ok || cycle.status === 'PAUSED'}
                title={completionGate.ok ? '完成本周期' : completionGate.error}
                onClick={() => setConfirmComplete(true)}
              >
                完成周期
              </Button>
            )}
          </>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile
            label="当前阶段"
            value={cycle.status === 'PAUSED' ? '暂停' : (progress.phase ?? '—')}
            hint={progress.phase ? CYCLE_PHASE_LABEL_ZH[progress.phase] : '已过 90 天，等待完成'}
            tone="plan"
          />
          <StatTile
            label="已进行"
            value={Math.max(0, Math.min(progress.dayNumber, CYCLE_TOTAL_DAYS))}
            unit={`/ ${CYCLE_TOTAL_DAYS} 天`}
            tone="neutral"
          />
          <StatTile label="剩余天数" value={progress.daysLeft} unit="天" tone="neutral" />
          <StatTile
            label="可比较输出"
            value={counts.comparableOutputs}
            unit="条"
            hint={`进入积累阶段需 ≥ ${CYCLE_BUILD_MIN_COMPARABLE_OUTPUTS}`}
            tone="output"
            scopeNote={CYCLE_COMPARABLE_NOTE_ZH}
          />
          <StatTile
            label="交付证据"
            value={counts.deliveryEvidence}
            unit="条"
            hint="实际应用 + 迁移验证"
            tone="mastery"
          />
        </div>

        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-surfaceAlt">
            <div
              className="h-full rounded-full bg-brand"
              style={{ width: `${progress.percent}%` }}
              role="progressbar"
              aria-valuenow={progress.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="周期进度"
            />
          </div>
          <p className="mt-1 text-[11px] text-inkMuted">
            第 {Math.max(1, Math.min(progress.dayNumber, CYCLE_TOTAL_DAYS))} 天 · 进度 {progress.percent}%
          </p>
        </div>
      </Card>

      <Card
        title="阶段与门槛"
        description={CYCLE_PHASE_GATE_NOTE_ZH}
        actions={
          advanceGate ? (
            <Button
              size="sm"
              variant="primary"
              disabled={pending || !advanceGate.ok || cycle.status === 'PAUSED'}
              title={advanceGate.ok ? '进入下一阶段' : advanceGate.error}
              onClick={() =>
                run(() => advanceCyclePhaseAction({ cycleId: cycle.id }), '已进入下一阶段')
              }
            >
              推进到下一阶段
            </Button>
          ) : null
        }
      >
        {advanceGate && !advanceGate.ok && (
          <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-ink">
            未满足推进条件：{advanceGate.error}
          </p>
        )}
        {cycle.status === 'PAUSED' && (
          <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-ink">
            周期已暂停：恢复后会按当天日期重新落到阶段，不会把暂停期间算成补课。
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          {CYCLE_PHASES.map((phase) => {
            const isCurrent = progress.phase === phase || cycle.status === phase;
            return (
              <div
                key={phase}
                className={`rounded-md border p-3 ${isCurrent ? 'border-brand bg-brand/5' : 'border-line bg-surfaceAlt/40'}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-ink">{CYCLE_PHASE_LABEL_ZH[phase]}</h3>
                  {isCurrent && <span className="text-[11px] font-medium text-brand">当前</span>}
                </div>
                <p className="mt-1 text-[11px] text-inkMuted">{CYCLE_PHASE_ADVICE_ZH[phase]}</p>
              </div>
            );
          })}
        </div>
      </Card>

      <RecoveryCard cycle={cycle} todayStr={todayStr} missedWeeks={missedWeeks} show={show} />

      <Card
        title="每周主问题"
        description={`${CYCLE_FOCUS_NOTE_ZH} 复盘默认 ${WEEKLY_REVIEW_MINUTES} 分钟。${CYCLE_NO_BACKLOG_NOTE_ZH}`}
      >
        <div className="mb-3 flex flex-wrap gap-1">
          {Array.from({ length: CYCLE_WEEKS }, (_, index) => index + 1).map((week) => {
            const item = cycle.weeklyFocus.find((focusItem) => focusItem.weekIndex === week);
            const isActive = week === weekIndex;
            return (
              <button
                key={week}
                type="button"
                onClick={() => setWeekIndex(week)}
                className={`rounded border px-2 py-1 text-[11px] ${
                  isActive
                    ? 'border-brand bg-brand/10 font-semibold text-brand'
                    : item?.status === 'REVIEWED'
                      ? 'border-line bg-egGreen/15 text-ink'
                      : 'border-line bg-white text-inkMuted hover:bg-surfaceAlt'
                }`}
                title={`第 ${week} 周 · ${cycleWeekStart(cycle.startDate, week)} 起`}
              >
                W{week}
                {item?.status === 'REVIEWED' ? ' ✓' : ''}
              </button>
            );
          })}
        </div>

        <WeeklyFocusForm
          key={`${cycle.id}-${weekIndex}`}
          cycle={cycle}
          weekIndex={weekIndex}
          focus={focus}
          evidenceOptions={board.evidenceOptions}
          show={show}
        />
      </Card>

      <ConfirmDialog
        open={confirmComplete}
        title="完成本次 90 天周期？"
        description={
          <span>
            完成后周复盘与进度会冻结为历史记录；如需继续学习，需要重新开启一个新周期。
          </span>
        }
        confirmLabel="完成周期"
        danger={false}
        busy={pending}
        onCancel={() => setConfirmComplete(false)}
        onConfirm={() => {
          setConfirmComplete(false);
          run(() => completeCycleAction({ cycleId: cycle.id }), '周期已完成，记录已冻结');
        }}
      />
    </div>
  );
}

function RecoveryCard({
  cycle,
  todayStr,
  missedWeeks,
  show,
}: {
  cycle: LearningCycleDto;
  todayStr: string;
  missedWeeks: number;
  show: ShowToast;
}) {
  const { pending, run } = useRunner(show);
  const [note, setNote] = useState(cycle.recoveryNote ?? '');
  const advice = buildRecoveryAdvice(todayStr);

  return (
    <Card title="中断恢复" description={CYCLE_RECOVERY_NOTE_ZH}>
      {missedWeeks > 0 && (
        <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-ink">
          已缺少 {missedWeeks} 周记录：不补排、不合并，直接从本周重新开始。
        </p>
      )}
      <p className="mb-2 rounded-md border border-line bg-surfaceAlt p-2 text-xs text-ink">
        {advice.message}
      </p>
      <FormField
        label="客观原因 + 最小下一步"
        hint={`不超过 300 字；只写一个 ${advice.minimalMinutes} 分钟内能完成的动作。`}
      >
        <textarea
          className={textareaClass}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={300}
          placeholder="例如：出差中断 9 天。今天只做 1 段 1 分钟 A0 口语录音，截止明天。"
        />
      </FormField>
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          disabled={pending || note.trim().length < 4}
          onClick={() =>
            run(
              () => saveRecoveryNoteAction({ cycleId: cycle.id, recoveryNote: note }),
              '恢复说明已保存',
            )
          }
        >
          {pending ? '保存中…' : '保存恢复说明'}
        </Button>
      </div>
    </Card>
  );
}

function WeeklyFocusForm({
  cycle,
  weekIndex,
  focus,
  evidenceOptions,
  show,
}: {
  cycle: LearningCycleDto;
  weekIndex: number;
  focus: WeeklyFocusDto | null;
  evidenceOptions: CycleEvidenceOptionDto[];
  show: ShowToast;
}) {
  const { pending, run } = useRunner(show);
  const [focusQuestion, setFocusQuestion] = useState(focus?.focusQuestion ?? '');
  const [inputText, setInputText] = useState(focus?.inputText ?? '');
  const [outputText, setOutputText] = useState(focus?.outputText ?? '');
  const [feedbackText, setFeedbackText] = useState(focus?.feedbackText ?? '');
  const [nextDecision, setNextDecision] = useState(focus?.nextDecision ?? '');
  const [transferEvidenceId, setTransferEvidenceId] = useState(focus?.transferEvidenceId ?? '');

  const draft = {
    focusQuestion,
    inputText,
    outputText,
    feedbackText,
    nextDecision,
  };
  const missing = weeklyFocusMissingSlots({
    ...draft,
    inputText: inputText || null,
    outputText: outputText || null,
    feedbackText: feedbackText || null,
    nextDecision: nextDecision || null,
  });
  const reviewGate = canReviewWeeklyFocus({
    ...draft,
    inputText: inputText || null,
    outputText: outputText || null,
    feedbackText: feedbackText || null,
    nextDecision: nextDecision || null,
  });
  const filled = weeklyFocusFilledSlots({
    inputText: inputText || null,
    outputText: outputText || null,
    feedbackText: feedbackText || null,
    transferEvidenceId: transferEvidenceId || null,
  });

  const payload = (reviewed: boolean) => ({
    cycleId: cycle.id,
    weekIndex,
    focusQuestion,
    inputText,
    outputText,
    feedbackText,
    nextDecision,
    transferEvidenceId: transferEvidenceId || undefined,
    reviewed,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-inkMuted">
        <span>
          第 {weekIndex} 周 · {cycleWeekStart(cycle.startDate, weekIndex)} 起
        </span>
        {focus && (
          <span className="rounded bg-surfaceAlt px-1.5 py-0.5">
            {WEEKLY_FOCUS_STATUS_LABEL_ZH[focus.status]}
          </span>
        )}
        <span>已填 {filled}/4（输入 / 输出 / 反馈 / 迁移证据）</span>
      </div>

      <FormField
        label="本周一个主问题"
        required
        hint="只写一个能在一次输出里观察的问题，不扩展成清单。"
      >
        <input
          className={inputClass}
          value={focusQuestion}
          onChange={(event) => setFocusQuestion(event.target.value)}
          maxLength={200}
          placeholder="例如：我能否在不看原文的情况下复述一段 90 秒材料？"
        />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="一项输入" hint="读了 / 听了什么材料。">
          <textarea
            className={textareaClass}
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            maxLength={2000}
          />
        </FormField>
        <FormField label="一项输出" hint="独立完成的具体产出（最好带原文或录音位置）。">
          <textarea
            className={textareaClass}
            value={outputText}
            onChange={(event) => setOutputText(event.target.value)}
            maxLength={2000}
          />
        </FormField>
        <FormField label="一次反馈" hint="谁给的反馈、具体指出什么。">
          <textarea
            className={textareaClass}
            value={feedbackText}
            onChange={(event) => setFeedbackText(event.target.value)}
            maxLength={2000}
          />
        </FormField>
        <FormField label="一项迁移证据（可后补）" hint="换题 / 换材料 / 换情境后的证据，可挂证据中心里的记录。">
          <select
            className={selectClass}
            value={transferEvidenceId}
            onChange={(event) => setTransferEvidenceId(event.target.value)}
          >
            <option value="">暂不关联</option>
            {evidenceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {EVIDENCE_SKILL_LABEL_ZH[option.skill]} ·{' '}
                {LEARNING_EVIDENCE_TYPE_LABEL_ZH[option.evidenceType]} ·{' '}
                {option.preview ?? '无预览'}（{option.businessDate}）
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <FormField label="下周决定" hint="下周是否继续同一问题；若换问题，写清原因。">
        <input
          className={inputClass}
          value={nextDecision}
          onChange={(event) => setNextDecision(event.target.value)}
          maxLength={300}
          placeholder="例如：继续同一问题一周；若正确率仍低于 70%，先补跟读再换题。"
        />
      </FormField>

      {focus?.status === 'REVIEWED' && (
        <p className="rounded-md border border-line bg-egGreen/10 p-2 text-[11px] text-ink">
          本周已复盘；修改后保存会重新计算状态。
        </p>
      )}
      {missing.length > 0 && (
        <p className="text-[11px] text-inkMuted">
          标记已复盘还缺：{missing.map((slot) => WEEKLY_FOCUS_SLOT_LABEL_ZH[slot]).join('、')}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          disabled={pending || focusQuestion.trim().length < 4}
          onClick={() => run(() => upsertWeeklyFocusAction(payload(false)), '本周复盘已保存为草稿')}
        >
          {pending ? '保存中…' : '保存草稿'}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={pending || !reviewGate.ok}
          title={reviewGate.ok ? '标记已复盘' : reviewGate.error}
          onClick={() => run(() => upsertWeeklyFocusAction(payload(true)), '本周复盘已标记完成')}
        >
          标记已复盘
        </Button>
      </div>
    </div>
  );
}

function HistoryCard({ history }: { history: LearningCycleDto[] }) {
  return (
    <Card title="历史周期" description="完成的周期会冻结为记录；最多展示最近 24 条。">
      {history.length === 0 ? (
        <EmptyState
          title="还没有已完成的周期"
          description="完成一个 90 天周期后，这里会保留每周主问题与交付证据，方便对照下一个周期。"
          icon="circle"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {history.map((cycle) => {
            const reviewed = cycle.weeklyFocus.filter((item) => item.status === 'REVIEWED').length;
            return (
              <li
                key={cycle.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface p-2.5"
              >
                <div>
                  <p className="text-sm font-medium text-ink">{cycle.title}</p>
                  <p className="text-[11px] text-inkMuted">
                    {cycle.startDate} → {cycle.endDate} · {cycle.goal}
                  </p>
                </div>
                <span className="rounded bg-egGreen/15 px-1.5 py-0.5 text-[11px] text-ink">
                  周复盘 {reviewed}/{CYCLE_WEEKS}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
