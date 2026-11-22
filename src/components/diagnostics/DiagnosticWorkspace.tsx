'use client';

/** 诊断会话工作区：一次一个任务，可暂停/继续，技术失败可标记无效。 */

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  finalizeDiagnosticAction,
  pauseDiagnosticAction,
  submitAttemptAction,
} from '@/lib/actions/diagnostics';
import {
  DIAG_DISCLAIMER_ZH,
  DIAG_SESSION_STATUS_LABEL_ZH,
  DIAG_ATTEMPT_STATUS_LABEL_ZH,
} from '@/lib/diagnostic/constants';
import type { DiagnosticSessionDto } from '@/lib/queries/diagnostics';
import { Button, buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast, useToastState } from '@/components/ui/Toast';

export interface DiagnosticWorkspaceProps {
  session: DiagnosticSessionDto;
  recordingConsent: boolean;
}

interface AudioDraft {
  dataUrl: string;
  mime: string;
  durationSec: number;
}

const AUDIO_LIMIT = 1_600_000;

export function DiagnosticWorkspace({ session, recordingConsent }: DiagnosticWorkspaceProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState(4200);
  const [pending, startTransition] = useTransition();

  const [answer, setAnswer] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [audio, setAudio] = useState<AudioDraft | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [invalidOpen, setInvalidOpen] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(Date.now());
  const item = session.currentItem;

  useEffect(() => {
    setAnswer('');
    setAudio(null);
    setSeconds(0);
    setRecordingError(null);
    startedAtRef.current = Date.now();
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [item?.id]);

  useEffect(() => {
    return () => {
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function speak() {
    if (!item?.transcript) {
      show('该题没有可用录音文本，请标记技术无效并稍后重试', 'error');
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      show('浏览器不支持语音合成，请标记技术无效并稍后重试', 'error');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(item.transcript);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  }

  async function startRecording() {
    setRecordingError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result ?? '');
          if (dataUrl.length > AUDIO_LIMIT) {
            setRecordingError('录音超过约 1.5MB，请缩短后重录，或标记技术无效。');
            setAudio(null);
          } else {
            setAudio({
              dataUrl,
              mime: blob.type || 'audio/webm',
              durationSec: Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)),
            });
          }
        };
        reader.readAsDataURL(blob);
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setRecordingError('无法访问麦克风（权限被拒或设备不可用）。可只用文字作答，或标记技术无效。');
      setRecording(false);
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  function submit(technicalFailed = false) {
    if (!item) return;
    startTransition(async () => {
      const result = await submitAttemptAction({
        sessionId: session.id,
        itemId: item.id,
        responseText: technicalFailed ? '' : answer,
        timeSpentSec: seconds,
        technicalFailed,
        technicalReason: technicalFailed ? '用户标记技术无效（设备/音频/环境问题）' : undefined,
        clientRequestId: `${session.id}:${item.id}:${Date.now()}`,
        audioDataUrl: technicalFailed ? undefined : audio?.dataUrl,
        audioMime: audio?.mime,
        audioDurationSec: audio?.durationSec,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      if (technicalFailed) show('已标记技术无效：不计分、不产生证据，稍后可重测。');
      else if (result.data.pendingEvaluation) {
        show('原始作答已保存；开放任务待评估（未启用外部 AI 时保持待评估，不会用模拟结果定级）。');
      } else {
        show('已提交，继续下一题。');
      }
      router.refresh();
    });
  }

  function togglePause(paused: boolean) {
    startTransition(async () => {
      const result = await pauseDiagnosticAction({ sessionId: session.id, paused });
      if (!result.ok) show(result.error, 'error');
      else router.refresh();
    });
  }

  function finalize() {
    startTransition(async () => {
      const result = await finalizeDiagnosticAction({ sessionId: session.id });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      router.push(`/diagnostics/report/${result.data.reportId}`);
    });
  }

  const paused = session.status === 'PAUSED';
  const completed = session.status === 'COMPLETED';
  const totalSeen = session.progress.answered + session.progress.plannedRemaining;
  const progressPercent = totalSeen > 0 ? Math.round((session.progress.answered / totalSeen) * 100) : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">诊断会话</h1>
          <p className="mt-0.5 text-xs text-inkMuted">
            {DIAG_SESSION_STATUS_LABEL_ZH[session.status as keyof typeof DIAG_SESSION_STATUS_LABEL_ZH] ?? session.status}
            {' · '}
            已完成 {session.progress.answered} 项，队列剩余 {session.progress.plannedRemaining} 项
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {!completed && (
            <Button size="sm" onClick={() => togglePause(!paused)} disabled={pending}>
              {paused ? '继续诊断' : '暂停'}
            </Button>
          )}
          <Link href="/diagnostics" className={buttonClass('ghost', 'sm')}>
            返回诊断首页
          </Link>
        </div>
      </div>

      <div className="h-2 w-full overflow-hidden rounded bg-surfaceAlt">
        <div className="h-2 bg-brand" style={{ width: `${progressPercent}%` }} />
      </div>

      {paused && (
        <Card dense>
          <p className="text-xs text-inkMuted">
            已暂停。已完成的作答与录音已保存，可以稍后继续；未完成项不会丢失。
          </p>
        </Card>
      )}

      {completed && (
        <Card title="本轮诊断已完成" dense>
          <p className="text-xs text-inkMuted">
            报告已生成，可在下方查看；如需补测，请从报告页发起新一轮诊断。
          </p>
          {session.reportId && (
            <Link href={`/diagnostics/report/${session.reportId}`} className={`${buttonClass('primary', 'sm')} mt-2`}>
              查看报告
            </Link>
          )}
        </Card>
      )}

      {!completed && !paused && item && (
        <Card
          title={`${item.skillLabel} · ${item.subskill}`}
          description={`难度 ${item.difficulty} / 4 · ${
            item.taskType === 'OPEN_TASK'
              ? '开放任务（按 rubric 评分）'
              : item.taskType === 'MCQ'
                ? '选择题（题库标准答案判分）'
                : '填空题（题库标准答案判分）'
          } · 已用 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}
        >
          {item.skill === 'LISTENING' && (
            <div className="mb-2 rounded border border-line bg-surfaceAlt p-2 text-xs text-inkMuted">
              首轮盲听：不显示录音文本。可重复播放；若设备无法播放，请标记技术无效并稍后重测。
              <div className="mt-1.5">
                <Button size="sm" onClick={speak}>
                  播放录音
                </Button>
              </div>
            </div>
          )}

          {item.passage && (
            <blockquote className="mb-2 rounded border-l-2 border-brand bg-surfaceAlt px-3 py-2 text-sm text-ink">
              {item.passage}
            </blockquote>
          )}

          <p className="whitespace-pre-wrap text-sm text-ink">{item.prompt}</p>
          {item.taskType === 'OPEN_TASK' && item.rubric.length > 0 && (
            <div className="mt-2 rounded border border-line p-2 text-xs">
              <div className="font-medium text-ink">评分规准（提交前可见，不显示参考答案）</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-inkMuted">
                {item.rubric.map((dimension) => (
                  <li key={dimension.id}>
                    {dimension.labelZh}：{dimension.descriptor}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3">
            {item.taskType === 'MCQ' ? (
              <div className="space-y-1.5">
                {item.options.map((option) => (
                  <label key={option.key} className="flex items-start gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name={`answer-${item.id}`}
                      checked={answer === option.key}
                      onChange={() => setAnswer(option.key)}
                      className="mt-0.5"
                    />
                    <span>
                      <strong>{option.key}.</strong> {option.text}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <textarea
                className="min-h-32 w-full rounded-md border border-line bg-white p-2 text-sm text-ink"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder={
                  item.taskType === 'OPEN_TASK'
                    ? '在这里写第一版作答；提交后不能覆盖原稿（可发起补测）。'
                    : '填写答案（忽略大小写与首尾空格）'
                }
              />
            )}
          </div>

          {item.taskType === 'OPEN_TASK' && item.skill === 'SPEAKING' && (
            <div className="mt-2 rounded border border-line p-2 text-xs">
              <div className="font-medium text-ink">录音（可选）</div>
              <p className="mt-0.5 text-inkMuted">
                录音仅保存在本机数据库，用于你的复核；ASR/文字不会单独用于发音评分。
                {!recordingConsent && ' 你尚未在背景信息中勾选录音同意，可只用文字作答。'}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {!recording ? (
                  <Button size="sm" onClick={startRecording} disabled={!recordingConsent}>
                    开始录音
                  </Button>
                ) : (
                  <Button size="sm" variant="danger" onClick={stopRecording}>
                    停止录音
                  </Button>
                )}
                {audio && (
                  <span className="text-emerald-700">
                    已录制 {audio.durationSec} 秒
                    <button
                      type="button"
                      className="ml-2 text-red-700 underline"
                      onClick={() => setAudio(null)}
                    >
                      删除录音
                    </button>
                  </span>
                )}
              </div>
              {recordingError && <p className="mt-1 text-red-700">{recordingError}</p>}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Button
              variant="primary"
              onClick={() => submit(false)}
              disabled={pending || (!answer.trim() && !(item.skill === 'SPEAKING' && audio))}
            >
              {pending ? '提交中…' : '提交此题'}
            </Button>
            <Button variant="secondary" onClick={() => setInvalidOpen(true)} disabled={pending}>
              标记技术无效
            </Button>
            {item.skill === 'EMLR' && (
              <Button variant="ghost" onClick={() => submit(true)} disabled={pending}>
                跳过可选模块
              </Button>
            )}
            <span className="text-[11px] text-inkMuted">{item.timingNote}</span>
          </div>
        </Card>
      )}

      {!completed && !paused && !item && session.progress.plannedRemaining === 0 && (
        <Card title="本轮题目已完成" dense>
          <p className="text-xs text-inkMuted">
            现在可以生成能力画像与报告。开放任务若仍待评估，报告会标为「暂定」并建议补测。
          </p>
          <Button variant="primary" className="mt-2" onClick={finalize} disabled={pending}>
            {pending ? '正在生成…' : '生成能力画像与报告'}
          </Button>
        </Card>
      )}

      {!completed && (
        <Card title="已提交记录" description="原始作答只保留第一版；技术无效的记录不会计分。">
          {session.attempts.length === 0 ? (
            <p className="text-xs text-inkMuted">还没有记录。</p>
          ) : (
            <ul className="divide-y divide-line text-xs">
              {session.attempts.map((attempt) => (
                <li key={attempt.id} className="py-2">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="text-ink">
                      {attempt.skillLabel} · {attempt.subskill} · 用时 {attempt.timeSpentSec ?? 0} 秒
                    </span>
                    <span className="text-inkMuted">
                      {DIAG_ATTEMPT_STATUS_LABEL_ZH[attempt.status as keyof typeof DIAG_ATTEMPT_STATUS_LABEL_ZH] ?? attempt.status}
                      {attempt.score !== null && ` · ${attempt.score}/2`}
                      {attempt.hasAudio && ' · 含录音'}
                    </span>
                  </div>
                  {attempt.dimensions.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 text-inkMuted">
                      {attempt.dimensions.map((dimension) => (
                        <li key={dimension.criterion}>
                          {dimension.criterion}：{dimension.score}/2（{dimension.evidence || '无引用'}）
                        </li>
                      ))}
                    </ul>
                  )}
                  {attempt.estimatedLevel && (
                    <p className="mt-0.5 text-inkMuted">
                      AI 辅助估计：{attempt.estimatedLevel}
                      {attempt.levelRange ? `（范围 ${attempt.levelRange.join('–')}）` : ''}
                      {attempt.confidence ? ` · 置信度 ${attempt.confidence}` : ''}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!paused && !item && (
            <Button variant="primary" className="mt-2" onClick={finalize} disabled={pending}>
              {pending ? '正在生成…' : '生成能力画像与报告'}
            </Button>
          )}
        </Card>
      )}

      <p className="text-[11px] text-inkMuted">{DIAG_DISCLAIMER_ZH}</p>

      <ConfirmDialog
        open={invalidOpen}
        title="标记为技术无效？"
        description="设备、录音或环境问题导致无法完成时使用。该次尝试不计分、不产生能力证据，并会重新排队以便重测。"
        confirmLabel="标记无效"
        onConfirm={() => {
          setInvalidOpen(false);
          submit(true);
        }}
        onCancel={() => setInvalidOpen(false)}
      />
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}