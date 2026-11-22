'use client';

/**
 * 会话工作台：任务、基线、诊断、提示、讲解、练习、即时复测与反馈。
 *
 * 交互约束：
 * - 未保存基线前不显示诊断/提示入口；
 * - 提示只能逐级 +1，最多 3 级；
 * - 练习答案在复测完成前不进入页面数据；
 * - 删除会话需二次确认，证据本身不会被删除。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  cancelAiSessionAction,
  deleteAiSessionAction,
  exportAiSessionAction,
  generateDrillAction,
  markTurnFeedbackAction,
  pauseAiSessionAction,
  promoteDiagnosisToMistakeAction,
  requestDiagnosisAction,
  requestHintAction,
  requestTeachingAction,
  resumeAiSessionAction,
  retryTaskAction,
  scheduleDelayedRetestAction,
  submitBaselineAction,
  submitImmediateRetestAction,
} from '@/lib/actions/tutor';
import {
  AI_ACCEPTED_AID_LABEL_ZH,
  AI_ASSESSMENT_DISCLAIMER_ZH,
  AI_COACH_MODE_LABEL_ZH,
  AI_EVIDENCE_AID_LEVELS,
  AI_FEEDBACK_HELPFULNESS_LABEL_ZH,
  AI_SESSION_STATUS_LABEL_ZH,
  AI_TURN_KIND_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
  type AiCoachMode,
  type AiFeedbackHelpfulness,
  type AiSessionStatus,
  type AiTurnKind,
} from '@/lib/constants';
import type { LearningEvidenceType } from '@/lib/types';
import { Button, buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';
import { Toast, useToastState } from '@/components/ui/Toast';

interface SessionDto {
  id: string;
  mode: string;
  skill: string;
  objective: string;
  targetLevel: string | null;
  status: string;
  provider: string;
  model: string;
  baselineText: string | null;
  taskSpecJson: string | null;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  directTeaching: boolean;
  failureReason: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
}

interface TurnDto {
  id: string;
  sequence: number;
  role: string;
  kind: string;
  contentText: string;
  structured: unknown;
  aidLevel: string | null;
  createdAt: Date | string;
  feedback: Array<{ helpfulness: string; note: string | null }>;
}

interface EvidenceDto {
  id: string;
  evidenceType: string;
  score: number | null;
  assistanceLevel: string;
  assessorType: string;
  note: string | null;
  createdAt: Date | string;
}

export interface AiSessionWorkspaceProps {
  session: SessionDto;
  turns: TurnDto[];
  evidence: EvidenceDto[];
  maxHintLevel: number;
  pendingRetests: number;
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseTask(raw: string | null): { instructions?: string; objective?: string; estimated_minutes?: number } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { instructions?: string; objective?: string; estimated_minutes?: number };
  } catch {
    return null;
  }
}

export function AiSessionWorkspace(props: AiSessionWorkspaceProps) {
  const { session, turns, evidence } = props;
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();
  const [baselineDraft, setBaselineDraft] = useState('');
  const [retestDraft, setRetestDraft] = useState('');
  const [aidLevel, setAidLevel] = useState('none');
  const [mistakeOpen, setMistakeOpen] = useState(false);
  const [mistake, setMistake] = useState({
    knowledgePoint: session.skill,
    originalQuestion: session.objective,
    myAnswer: session.baselineText ?? '',
    correctAnswer: '',
    errorReason: '',
  });

  const status = session.status as AiSessionStatus;
  const task = parseTask(session.taskSpecJson);
  const canBaseline = status === 'TASK_PRESENTED' && !session.baselineText;
  const canDiagnose = status === 'BASELINE_SUBMITTED';
  const canSupport = ['FEEDBACK_READY', 'HINTING', 'TEACHING', 'PRACTICE'].includes(status);
  const canRetest = ['FEEDBACK_READY', 'TEACHING', 'PRACTICE'].includes(status);
  const canSchedule = status === 'COMPLETED' || status === 'DELAYED_RETEST_SCHEDULED';
  const canPause = !['COMPLETED', 'DELAYED_RETEST_SCHEDULED', 'CANCELLED', 'FAILED', 'PAUSED'].includes(
    status,
  );
  const nextHint = Math.min(3, props.maxHintLevel + 1);
  const diagnosisTurn = [...turns].reverse().find((turn) => turn.kind === 'DIAGNOSIS');
  const latestAssessment = [...turns].reverse().find((turn) => turn.kind === 'ASSESSMENT');

  function run<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, success: string) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show(success, 'success');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Toast toast={toast} onDismiss={dismiss} />

      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-inkMuted">
          <Link href="/ai-coach" className="underline">
            ← AI Learning Coach
          </Link>
          <span>{AI_COACH_MODE_LABEL_ZH[session.mode as AiCoachMode] ?? session.mode}</span>
          <span>/ {session.skill}</span>
          <span>/ 目标等级 {session.targetLevel ?? '自动'}</span>
          <span className="rounded-full border border-line px-2 py-0.5">
            {AI_SESSION_STATUS_LABEL_ZH[status] ?? status}
          </span>
          <span title="Provider / Model">
            {session.provider} · {session.model}
          </span>
          {session.directTeaching && (
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-800">
              direct teaching（assisted）
            </span>
          )}
        </div>
        <h1 className="text-lg font-semibold text-ink">{session.objective}</h1>
        {session.failureReason && (
          <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            上次失败：{session.failureReason}
          </p>
        )}
      </header>

      {status === 'CREATED' && (
        <Card title="任务尚未生成" description="可以重试一次；失败不会产生费用（模拟模型）或重复轮次。">
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              run(() => retryTaskAction({ sessionId: session.id }), '任务已生成')
            }
          >
            重试生成任务
          </Button>
        </Card>
      )}

      {task && (
        <Card title="本次任务（TaskSpec）" description={task.objective ?? session.objective}>
          <p className="whitespace-pre-wrap text-sm text-ink">{task.instructions}</p>
          <p className="mt-2 text-xs text-inkMuted">
            预计 {task.estimated_minutes ?? '—'} 分钟；先独立作答，再使用提示或讲解。
          </p>
        </Card>
      )}

      {canBaseline && (
        <Card
          title="第 1 步：独立基线"
          description="原始作答保存后不可覆盖；AI 反馈不会改写它。"
        >
          <textarea
            className={textareaClass}
            value={baselineDraft}
            onChange={(event) => setBaselineDraft(event.target.value)}
            placeholder="先自己写，不要查翻译。允许写「不确定」的地方。"
            maxLength={8000}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              disabled={pending || baselineDraft.trim().length === 0}
              onClick={() =>
                run(
                  () =>
                    submitBaselineAction({
                      sessionId: session.id,
                      text: baselineDraft,
                      clientRequestId: newRequestId(),
                    }),
                  '基线已保存并写入证据',
                )
              }
            >
              保存独立基线
            </Button>
            <span className="text-[11px] text-inkMuted">
              保存后会同时生成 BASELINE 证据与复测阶梯。
            </span>
          </div>
        </Card>
      )}

      {canDiagnose && (
        <Card title="第 2 步：诊断" description="诊断必须引用你的原句；证据不足时会明确说明。">
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  requestDiagnosisAction({
                    sessionId: session.id,
                    clientRequestId: newRequestId(),
                  }),
                '诊断已完成',
              )
            }
          >
            请求诊断
          </Button>
        </Card>
      )}

      {canSupport && (
        <Card title="第 3 步：提示 / 讲解 / 练习" description="提示按级别逐次解锁；讲解与练习属于 assisted。">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    requestHintAction({
                      sessionId: session.id,
                      level: nextHint,
                      clientRequestId: newRequestId(),
                    }),
                  `已获得第 ${nextHint} 级提示`,
                )
              }
            >
              请求第 {nextHint} 级提示
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    requestTeachingAction({
                      sessionId: session.id,
                      clientRequestId: newRequestId(),
                    }),
                  '讲解已生成（assisted）',
                )
              }
            >
              请求讲解
            </Button>
            <Button
              variant="secondary"
              disabled={pending || !diagnosisTurn}
              onClick={() =>
                run(
                  () =>
                    generateDrillAction({
                      sessionId: session.id,
                      clientRequestId: newRequestId(),
                    }),
                  '变式练习已生成',
                )
              }
            >
              生成变式练习
            </Button>
            <span className="text-[11px] text-inkMuted">
              已用最高提示级别：{props.maxHintLevel} / 3
            </span>
          </div>
          {props.maxHintLevel >= 3 && (
            <p className="mt-2 text-xs text-amber-800">
              已到最高提示级别；接下来请完成不看提示的独立复测。
            </p>
          )}
        </Card>
      )}

      {canRetest && (
        <Card
          title="第 4 步：独立即时复测"
          description="请换新题/新句/新主题，不使用此前提示；结果记为 IMMEDIATE_RETEST 证据。"
        >
          <textarea
            className={textareaClass}
            value={retestDraft}
            onChange={(event) => setRetestDraft(event.target.value)}
            placeholder="不看提示，重新完成一个平行任务。"
            maxLength={8000}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <FormField label="本次使用的辅助" htmlFor="aid-level">
              <select
                id="aid-level"
                className={selectClass}
                value={aidLevel}
                onChange={(event) => setAidLevel(event.target.value)}
              >
                {AI_EVIDENCE_AID_LEVELS.map((item) => (
                  <option key={item} value={item}>
                    {item === 'none' ? '无辅助（计入独立证据上限）' : item}
                  </option>
                ))}
              </select>
            </FormField>
            <Button
              variant="primary"
              disabled={pending || retestDraft.trim().length === 0}
              onClick={() =>
                run(
                  () =>
                    submitImmediateRetestAction({
                      sessionId: session.id,
                      text: retestDraft,
                      aidLevel: aidLevel as (typeof AI_EVIDENCE_AID_LEVELS)[number],
                      clientRequestId: newRequestId(),
                    }),
                  '复测已评估并写入证据',
                )
              }
            >
              提交复测并评估
            </Button>
          </div>
        </Card>
      )}

      {canSchedule && (
        <Card
          title="第 5 步：延迟复测"
          description="按统一规则排 7 / 30 / 84 天复测；到期后到「复测与迁移」页完成。"
        >
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                run(
                  () => scheduleDelayedRetestAction({ sessionId: session.id }),
                  '延迟复测已确认排期',
                )
              }
            >
              确认延迟复测排期
            </Button>
            <span className="text-xs text-inkMuted">当前待执行复测：{props.pendingRetests} 项</span>
            <Link className={buttonClass('ghost', 'sm')} href="/retest">
              去复测页
            </Link>
          </div>
        </Card>
      )}

      <Card title="会话轮次" description="用户原始作答与 AI 输出分列保存；可对 AI 反馈标记帮助程度。">
        {turns.length === 0 ? (
          <p className="text-xs text-inkMuted">还没有轮次。</p>
        ) : (
          <ol className="space-y-2">
            {turns.map((turn) => (
              <li
                key={turn.id}
                className={[
                  'rounded-md border p-2.5',
                  turn.role === 'USER'
                    ? 'border-blue-200 bg-blue-50/60'
                    : 'border-line bg-surfaceAlt',
                ].join(' ')}
              >
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-inkMuted">
                  <span className="font-medium text-ink">
                    #{turn.sequence} {turn.role === 'USER' ? '我' : 'AI'}
                  </span>
                  <span>{AI_TURN_KIND_LABEL_ZH[turn.kind as AiTurnKind] ?? turn.kind}</span>
                  {turn.aidLevel && <span>辅助：{turn.aidLevel}</span>}
                  <span>{new Date(turn.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{turn.contentText}</p>
                {turn.role === 'AI' && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {(['HELPFUL', 'UNHELPFUL', 'INACCURATE'] as AiFeedbackHelpfulness[]).map(
                      (value) => (
                        <button
                          key={value}
                          type="button"
                          className={buttonClass('ghost', 'sm')}
                          disabled={pending}
                          onClick={() =>
                            run(
                              () =>
                                markTurnFeedbackAction({
                                  sessionId: session.id,
                                  turnId: turn.id,
                                  helpfulness: value,
                                }),
                              `已记录：${AI_FEEDBACK_HELPFULNESS_LABEL_ZH[value]}`,
                            )
                          }
                        >
                          {AI_FEEDBACK_HELPFULNESS_LABEL_ZH[value]}
                        </button>
                      ),
                    )}
                    {turn.feedback.length > 0 && (
                      <span className="text-[11px] text-inkMuted">
                        已反馈：
                        {turn.feedback
                          .map(
                            (item) =>
                              AI_FEEDBACK_HELPFULNESS_LABEL_ZH[
                                item.helpfulness as AiFeedbackHelpfulness
                              ] ?? item.helpfulness,
                          )
                          .join('、')}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {diagnosisTurn && (
        <Card
          title="把诊断转为错题（需你确认）"
          description="AI 只提供候选；题目、答案与原因由你确认后写入错题本，并进入统一复习调度。"
          actions={
            <Button variant="ghost" size="sm" onClick={() => setMistakeOpen((value) => !value)}>
              {mistakeOpen ? '收起' : '展开填写'}
            </Button>
          }
        >
          {mistakeOpen && (
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <FormField label="知识点" required>
                  <input
                    className={inputClass}
                    value={mistake.knowledgePoint}
                    onChange={(event) =>
                      setMistake((prev) => ({ ...prev, knowledgePoint: event.target.value }))
                    }
                  />
                </FormField>
                <FormField label="原题" required>
                  <input
                    className={inputClass}
                    value={mistake.originalQuestion}
                    onChange={(event) =>
                      setMistake((prev) => ({ ...prev, originalQuestion: event.target.value }))
                    }
                  />
                </FormField>
              </div>
              <FormField label="我的答案">
                <textarea
                  className={textareaClass}
                  value={mistake.myAnswer}
                  onChange={(event) =>
                    setMistake((prev) => ({ ...prev, myAnswer: event.target.value }))
                  }
                />
              </FormField>
              <div className="grid gap-2 sm:grid-cols-2">
                <FormField label="参考答案" required>
                  <input
                    className={inputClass}
                    value={mistake.correctAnswer}
                    onChange={(event) =>
                      setMistake((prev) => ({ ...prev, correctAnswer: event.target.value }))
                    }
                  />
                </FormField>
                <FormField label="错误原因" required>
                  <input
                    className={inputClass}
                    value={mistake.errorReason}
                    onChange={(event) =>
                      setMistake((prev) => ({ ...prev, errorReason: event.target.value }))
                    }
                  />
                </FormField>
              </div>
              <Button
                variant="primary"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      promoteDiagnosisToMistakeAction({
                        sessionId: session.id,
                        ...mistake,
                      }),
                    '已写入错题本并安排首次复习',
                  )
                }
              >
                确认写入错题本
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card title="证据" description="AI 评估证据固定为 assessorType=AI，并带免责声明。">
        {evidence.length === 0 ? (
          <p className="text-xs text-inkMuted">还没有证据。</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {evidence.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 border-b border-line/60 pb-1">
                <span className="font-medium text-ink">
                  {LEARNING_EVIDENCE_TYPE_LABEL_ZH[item.evidenceType as LearningEvidenceType] ??
                    item.evidenceType}
                </span>
                <span>评分 {item.score ?? '—'} / 2</span>
                <span>辅助 {item.assistanceLevel}</span>
                <span>评估者 {item.assessorType}</span>
                <span className="text-inkMuted">{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
              </li>
            ))}
          </ul>
        )}
        {latestAssessment && (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
            {AI_ASSESSMENT_DISCLAIMER_ZH}
          </p>
        )}
      </Card>

      <Card title="会话操作" description="暂停保留现场；删除会话不会删除已有证据。">
        <div className="flex flex-wrap gap-1.5">
          {canPause && (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => run(() => pauseAiSessionAction({ sessionId: session.id }), '会话已暂停')}
            >
              暂停
            </Button>
          )}
          {status === 'PAUSED' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => run(() => resumeAiSessionAction({ sessionId: session.id }), '会话已继续')}
            >
              继续
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await exportAiSessionAction({ sessionId: session.id });
                if (!result.ok) {
                  show(result.error, 'error');
                  return;
                }
                const blob = new Blob([result.data.json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = result.data.filename;
                anchor.click();
                URL.revokeObjectURL(url);
                show('会话 JSON 已导出', 'success');
              })
            }
          >
            导出会话 JSON
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || ['CANCELLED', 'FAILED'].includes(status)}
            onClick={() => run(() => cancelAiSessionAction({ sessionId: session.id }), '会话已取消')}
          >
            取消会话
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (!window.confirm('删除会话？已写入的证据会保留，但会话轮次与调用日志会被清除。')) return;
              startTransition(async () => {
                const result = await deleteAiSessionAction({ sessionId: session.id });
                if (!result.ok) {
                  show(result.error, 'error');
                  return;
                }
                router.push('/ai-coach');
              });
            }}
          >
            删除会话
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-inkMuted">
          {AI_ACCEPTED_AID_LABEL_ZH.DICTIONARY} / {AI_ACCEPTED_AID_LABEL_ZH.TRANSLATION} 等工具使用情况会写入复测证据的辅助等级。
        </p>
      </Card>
    </div>
  );
}