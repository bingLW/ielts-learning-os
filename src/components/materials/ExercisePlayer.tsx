'use client';

/**
 * 练习作答器（一题一屏，提交后才揭示答案）。
 *
 * 三条产品口径：
 * 1. **作答前拿不到答案**：题目 DTO 是服务端 `revealAnswers=false` 产出的
 *    （`correctKey` / `explanation` 为 null），所以这里没有任何"本地判分"的可能 ——
 *    判分只发生在 `submitExerciseAttemptAction`；
 * 2. **提交即落库**：每次提交都写一条 `ExerciseAttempt`（`evidenceType=PRACTICE_ONLY`，
 *    不创建 `EvidenceRecord`）。答错也算作答记录，不是"白点一下就没了"；
 * 3. **答完必须给依据**：结果区固定显示 `EvidenceQuotePanel`，让用户能立刻回原文
 *    核对"我为什么错"，而不是只看到一个红叉。
 */

import { useMemo, useRef, useState } from 'react';
import { EvidenceQuotePanel } from '@/components/materials/EvidenceQuotePanel';
import { Icon } from '@/components/ui/Icon';
import {
  MATERIAL_EXERCISE_TYPE_LABELS_ZH,
  type MaterialConsistencyStatus,
} from '@/lib/constants';
import { submitExerciseAttemptAction } from '@/lib/actions/materialExercises';
import type { ExerciseDto } from '@/lib/queries/materials';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';

const BTN_SECONDARY = `${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`;
const BTN_PRIMARY = `${BTN} border-brand bg-brand text-white hover:bg-blue-700`;

/** 一次提交的结果（与 action 返回一致，只在客户端保存）。 */
interface AttemptOutcome {
  isCorrect: boolean;
  correctKey: string;
  explanation: string;
  evidenceQuote: string;
  consistencyCheck: MaterialConsistencyStatus;
  consistencyNote: string | null;
  canEnterPlacement: boolean;
}

export interface ExercisePlayerProps {
  setId: string;
  materialId: string;
  exercises: ExerciseDto[];
}

export function ExercisePlayer({ setId, materialId, exercises }: ExercisePlayerProps) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AttemptOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(0);
  const [correct, setCorrect] = useState(0);
  const startedAt = useRef<number>(Date.now());

  const current = exercises[index] ?? null;
  const finished = exercises.length > 0 && index >= exercises.length;

  const progressText = useMemo(() => {
    if (exercises.length === 0) return '没有可作答的题';
    return `第 ${Math.min(index + 1, exercises.length)} / ${exercises.length} 题 · 已答 ${answered} 题 · 答对 ${correct} 题`;
  }, [answered, correct, exercises.length, index]);

  const submit = async (): Promise<void> => {
    if (!current || selected === null) {
      setError('请选择一个答案');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await submitExerciseAttemptAction({
        exerciseId: current.id,
        selectedKey: selected,
        elapsedSec: Math.max(0, Math.round((Date.now() - startedAt.current) / 1000)),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome({
        isCorrect: result.data.isCorrect,
        correctKey: result.data.correctKey,
        explanation: result.data.explanation,
        evidenceQuote: result.data.evidenceQuote,
        consistencyCheck: result.data.consistencyCheck,
        consistencyNote: result.data.consistencyNote,
        canEnterPlacement: result.data.canEnterPlacement,
      });
      setAnswered((prev) => prev + 1);
      if (result.data.isCorrect) setCorrect((prev) => prev + 1);
    } finally {
      setBusy(false);
    }
  };

  const next = (): void => {
    setOutcome(null);
    setSelected(null);
    setError(null);
    startedAt.current = Date.now();
    setIndex((prev) => prev + 1);
  };

  const restart = (): void => {
    setOutcome(null);
    setSelected(null);
    setError(null);
    setAnswered(0);
    setCorrect(0);
    startedAt.current = Date.now();
    setIndex(0);
  };

  if (exercises.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-surface p-4 text-xs leading-relaxed text-inkMuted">
        这份练习集暂时没有可作答的题（题可能都被拒绝或退役了）。请回到材料页重新生成或审核题目。
      </p>
    );
  }

  return (
    <div className="space-y-3" data-set-id={setId}>
      <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-line bg-surfaceAlt px-2.5 py-1.5">
        <span className="text-[11px] text-ink">{progressText}</span>
        <span className="text-[10px] text-inkMuted">
          练习记录不计入独立证据（PRACTICE_ONLY）
        </span>
      </div>

      {finished ? (
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Icon name="check" size={14} />
            这一轮做完了：{answered} 题，答对 {correct} 题
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-inkMuted">
            这些作答只作为练习记录保存，不会生成 EvidenceRecord，也不会影响你的能力画像。
            想复盘的话，用下面的「重新做一遍」或回原文核对依据。
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" onClick={restart} className={BTN_PRIMARY}>
              <Icon name="repeat" size={11} />
              重新做一遍
            </button>
            <a href={`/materials/${materialId}/exercises`} className={BTN_SECONDARY}>
              回到练习审核页
            </a>
          </div>
        </div>
      ) : current ? (
        <article className="rounded-lg border border-line bg-surface p-3">
          <header className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-ink">
              {MATERIAL_EXERCISE_TYPE_LABELS_ZH[current.type]}
            </span>
            {current.difficultyEstimate && (
              <span className="rounded border border-line bg-surfaceAlt px-1 py-0.5 text-[10px] text-inkMuted">
                AI 难度估计 {current.difficultyEstimate}
              </span>
            )}
          </header>

          <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
            {current.prompt}
          </p>

          <div className="mt-2 space-y-1">
            {current.options.map((option) => {
              const chosen = selected === option.key;
              const isAnswer = outcome !== null && outcome.correctKey === option.key;
              const wrongPick = outcome !== null && chosen && !outcome.isCorrect;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setSelected(option.key)}
                  disabled={busy || outcome !== null}
                  className={[
                    'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-[11px] leading-relaxed transition-colors disabled:cursor-default',
                    isAnswer
                      ? 'border-egGreen/50 bg-egGreen/10 text-ink'
                      : wrongPick
                        ? 'border-egRed/50 bg-egRed/10 text-ink'
                        : chosen
                          ? 'border-brand bg-brand/5 text-ink'
                          : 'border-line bg-surface text-ink hover:bg-surfaceAlt',
                  ].join(' ')}
                >
                  <span className="w-4 shrink-0 text-inkMuted">{option.key}</span>
                  <span className="min-w-0 flex-1 break-words">{option.text}</span>
                  {isAnswer && (
                    <span className="shrink-0 text-[10px] text-egGreen">正确答案</span>
                  )}
                </button>
              );
            })}
          </div>

          {error && <p className="mt-1.5 text-[11px] text-egRed">{error}</p>}

          {outcome && (
            <div className="mt-2 space-y-1.5">
              <p
                className={[
                  'rounded-md border px-2 py-1.5 text-[11px]',
                  outcome.isCorrect
                    ? 'border-egGreen/40 bg-egGreen/10 text-ink'
                    : 'border-egRed/40 bg-egRed/10 text-ink',
                ].join(' ')}
              >
                {outcome.isCorrect
                  ? '答对了。再读一遍下面的原文依据，确认是真的读懂了而不是猜对。'
                  : `答错了：正确答案是 ${outcome.correctKey}。`}
              </p>
              {outcome.explanation.trim().length > 0 && (
                <p className="text-[11px] leading-relaxed text-ink">
                  解析：{outcome.explanation}
                </p>
              )}
              <EvidenceQuotePanel
                quote={outcome.evidenceQuote}
                chunkId={current.chunkId}
                materialId={materialId}
                consistencyCheck={outcome.consistencyCheck}
                consistencyNote={outcome.consistencyNote}
              />
              {!outcome.canEnterPlacement && (
                <p className="text-[10px] leading-relaxed text-inkMuted">
                  这道题还没通过审核，因此这次作答只作练习记录，不会进入正式测评或排程。
                </p>
              )}
            </div>
          )}

          <footer className="mt-2 flex flex-wrap items-center gap-1.5">
            {outcome === null ? (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || selected === null}
                className={BTN_PRIMARY}
              >
                <Icon name="check" size={11} />
                提交答案
              </button>
            ) : (
              <button type="button" onClick={next} className={BTN_PRIMARY}>
                <Icon name="play" size={11} />
                {index + 1 >= exercises.length ? '完成' : '下一题'}
              </button>
            )}
            <a href={`/materials/${materialId}/read?chunk=${current.chunkId}`} className={BTN_SECONDARY}>
              <Icon name="search" size={11} />
              看原文
            </a>
          </footer>
        </article>
      ) : null}
    </div>
  );
}
