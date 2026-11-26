'use client';

/** 诊断报告：四项技能画像、证据、复核、补测与计划草案确认。 */

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  confirmDiagnosticPlanAction,
  deleteDiagnosticSessionAction,
  requestReviewAction,
  retestAction,
} from '@/lib/actions/diagnostics';
import {
  DIAG_DISCLAIMER_ZH,
  DIAG_REPORT_STATUS_LABEL_ZH,
  DIAG_CONFIDENCE_LABEL_ZH,
} from '@/lib/diagnostic/constants';
import type { DiagnosticReportDto } from '@/lib/queries/diagnostics';
import { Button, buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast, useToastState } from '@/components/ui/Toast';

export interface DiagnosticReportProps {
  report: DiagnosticReportDto;
}

export function DiagnosticReport({ report }: DiagnosticReportProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState(4500);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [phases, setPhases] = useState(report.proposal?.phases ?? []);

  const core = report.snapshots.filter((snapshot) =>
    ['LISTENING', 'READING', 'SPEAKING', 'WRITING'].includes(snapshot.skill),
  );
  const aux = report.snapshots.filter(
    (snapshot) => !['LISTENING', 'READING', 'SPEAKING', 'WRITING'].includes(snapshot.skill),
  );

  function continueToBuilder() {
    const proposalId = report.proposal?.id;
    if (!proposalId) return;
    startTransition(async () => {
      const result = await confirmDiagnosticPlanAction({
        proposalId,
        tasks: phases.map((phase) => ({
          window: phase.window as '7D' | '30D' | '90D',
          focus: phase.focus,
          tasks: phase.tasks.map((task) => ({
            title: task.title,
            minutes: task.minutes,
            skill: task.skill,
            evidenceRef: task.evidenceRef,
            reason: task.reason,
          })),
        })),
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      router.push(`/planner/build?horizon=7&proposal=${encodeURIComponent(proposalId)}`);
    });
  }

  function requestReview() {
    startTransition(async () => {
      const result = await requestReviewAction({ reportId: report.id, reason });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      setReason('');
      show('复核申请已记录，旧报告保持不变。');
      router.refresh();
    });
  }

  function retest() {
    startTransition(async () => {
      const result = await retestAction({ reportId: report.id });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      router.push(`/diagnostics/${result.data.sessionId}`);
    });
  }

  function removeSession() {
    startTransition(async () => {
      const result = await deleteDiagnosticSessionAction({ sessionId: report.sessionId });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      router.push('/diagnostics');
    });
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `diagnostic-report-${report.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function updateTask(window: string, index: number, minutes: number) {
    setPhases((current) =>
      current.map((phase) =>
        phase.window === window
          ? {
              ...phase,
              tasks: phase.tasks.map((task, taskIndex) =>
                taskIndex === index ? { ...task, minutes } : task,
              ),
            }
          : phase,
      ),
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">当前能力画像与诊断报告</h1>
          <p className="mt-0.5 text-xs text-inkMuted">
            {DIAG_REPORT_STATUS_LABEL_ZH[report.status as keyof typeof DIAG_REPORT_STATUS_LABEL_ZH] ?? report.status}
            {' · '}
            整体置信度 {DIAG_CONFIDENCE_LABEL_ZH[report.confidence as keyof typeof DIAG_CONFIDENCE_LABEL_ZH] ?? report.confidence}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={exportJson}>
            导出 JSON
          </Button>
          <Button size="sm" onClick={retest} disabled={pending}>
            发起补测
          </Button>
          <Link href="/diagnostics" className={buttonClass('ghost', 'sm')}>
            返回
          </Link>
        </div>
      </div>

      <Card title="四项核心技能（分别呈现，不取平均）">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {core.map((snapshot) => (
            <div key={snapshot.skill} className="rounded border border-line p-2 text-xs">
              <div className="font-semibold text-ink">{snapshot.skillLabel}</div>
              <div className="mt-1 text-lg text-ink">
                {snapshot.estimatedLevel ?? (snapshot.levelRange ? `${snapshot.levelRange[0]}–${snapshot.levelRange[1]}` : '暂不能判断')}
              </div>
              <div className="text-inkMuted">
                范围 {snapshot.levelRange?.join('–') ?? '—'} · 证据 {snapshot.evidenceCount} 条
              </div>
              <div className="text-inkMuted">
                覆盖 {snapshot.coverageRatio === null ? '未知' : `${Math.round(snapshot.coverageRatio * 100)}%`} · 置信度{' '}
                {DIAG_CONFIDENCE_LABEL_ZH[snapshot.confidence as keyof typeof DIAG_CONFIDENCE_LABEL_ZH] ?? snapshot.confidence}
              </div>
              {snapshot.needsFollowUp && (
                <div className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-amber-800">
                  暂定：建议补测
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {aux.length > 0 && (
        <Card title="辅助能力画像" description="Grammar / Vocabulary / Sentence Structure / EMLR 不作为第五至第七项官方能力。">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {aux.map((snapshot) => (
              <div key={snapshot.skill} className="rounded border border-line p-2 text-xs">
                <div className="font-semibold text-ink">{snapshot.skillLabel}</div>
                <div className="mt-1 text-ink">
                  {snapshot.estimatedLevel ?? (snapshot.levelRange ? `${snapshot.levelRange[0]}–${snapshot.levelRange[1]}` : '未评估')}
                </div>
                <div className="text-inkMuted">证据 {snapshot.evidenceCount} 条 · {snapshot.confidence}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="报告摘要">
          <p className="whitespace-pre-wrap text-xs text-ink">{report.summary}</p>
          <div className="mt-2">
            <div className="text-xs font-medium text-ink">主要优势</div>
            <ul className="list-disc pl-4 text-xs text-inkMuted">
              {report.strengths.length > 0 ? report.strengths.map((item) => <li key={item}>{item}</li>) : <li>暂无（证据不足）</li>}
            </ul>
          </div>
          <div className="mt-2">
            <div className="text-xs font-medium text-ink">优先缺口</div>
            <ul className="list-disc pl-4 text-xs text-inkMuted">
              {report.gaps.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        </Card>
        <Card title="建议与局限">
          <ul className="list-disc pl-4 text-xs text-inkMuted">
            {report.suggestions.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <div className="mt-2 text-xs font-medium text-ink">局限与声明</div>
          <ul className="list-disc pl-4 text-xs text-inkMuted">
            {report.limitations.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </Card>
      </div>

      <Card title="证据列表" description="每个结论可追溯到任务、原始作答、rubric 与评分证据；技术无效记录不计分。">
        <ul className="divide-y divide-line text-xs">
          {report.attempts.map((attempt) => (
            <li key={attempt.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="font-medium text-ink">
                  {attempt.itemCode} · {attempt.skillLabel} · {attempt.subskill}
                </span>
                <span className="text-inkMuted">
                  {attempt.status}
                  {attempt.score !== null && ` · ${attempt.score}/2`}
                  {attempt.hasAudio && ' · 含录音'}
                </span>
              </div>
              {attempt.responseText && (
                <p className="mt-1 whitespace-pre-wrap rounded bg-surfaceAlt p-1.5 text-ink">
                  {attempt.responseText.slice(0, 500)}
                  {attempt.responseText.length > 500 ? '…' : ''}
                </p>
              )}
              {attempt.dimensions.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-inkMuted">
                  {attempt.dimensions.map((dimension) => (
                    <li key={dimension.criterion}>
                      {dimension.criterion}：{dimension.score}/2 · {dimension.evidence || '无引用'}
                    </li>
                  ))}
                </ul>
              )}
              {attempt.estimatedLevel && (
                <p className="mt-1 text-inkMuted">
                  AI 辅助估计 {attempt.estimatedLevel}（{attempt.levelRange?.join('–') ?? '—'}，置信度 {attempt.confidence}）
                </p>
              )}
              {attempt.aiAudit && (
                <p className="mt-0.5 text-inkMuted">
                  AI 审计：模型 {attempt.aiAudit.modelId ?? '未记录'} · Prompt {attempt.aiAudit.promptVersionId ?? '未记录'} · Rubric {attempt.aiAudit.rubricVersion ?? '未记录'} · 调用 {attempt.aiAudit.callLogId ?? '未记录'}
                </p>
              )}
              {attempt.limitations.length > 0 && (
                <p className="mt-0.5 text-inkMuted">限制：{attempt.limitations.join('；')}</p>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {report.proposal && (
        <Card
          title="学习计划草案"
          description={`每周预算 ${report.proposal.budget?.weeklyMinutes ?? '—'} 分钟（${report.proposal.budget?.source ?? '未知来源'}）；保存后进入 Planner 预览，再次确认才写入正式计划。`}
        >
          {report.proposal.notes.length > 0 && (
            <ul className="mb-2 list-disc pl-4 text-xs text-inkMuted">
              {report.proposal.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}
          <div className="grid gap-2 lg:grid-cols-3">
            {phases.map((phase) => (
              <div key={phase.window} className="rounded border border-line p-2 text-xs">
                <div className="font-semibold text-ink">
                  {phase.window === '7D' ? '7 天启动' : phase.window === '30D' ? '30 天第一阶段' : '90 天方向'} · {phase.focus}
                </div>
                <ul className="mt-1 space-y-1.5">
                  {phase.tasks.map((task, index) => (
                    <li key={`${phase.window}-${index}`}>
                      <div className="text-ink">{task.title}</div>
                      <div className="mt-0.5 flex items-center gap-1">
                        <input
                          type="number"
                          min={5}
                          max={240}
                          value={task.minutes}
                          onChange={(event) => updateTask(phase.window, index, Number(event.target.value))}
                          className="w-16 rounded border border-line px-1 py-0.5 text-xs"
                        />
                        <span className="text-inkMuted">分钟 · 关联 {task.evidenceRef}</span>
                      </div>
                      <div className="text-inkMuted">{task.reason}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {report.proposal.status === 'ACTIVE' && (
              <span className="text-xs text-amber-700">
                此草案已完成 Planner 确认；正式任务与版本请以 Planner 记录为准，不能重复激活。
              </span>
            )}
            <Button variant="primary" onClick={continueToBuilder} disabled={pending || report.proposal.status === 'ACTIVE'}>
              {pending ? '正在保存…' : '保存草案并进入 Planner'}
            </Button>
          </div>
        </Card>
      )}

      <Card title="复核与数据管理">
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <textarea
              className="min-h-20 w-full rounded-md border border-line bg-white p-2 text-xs"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="如果认为某项评估不准确，请说明原因（例如录音失败、题目歧义）；旧报告不会被覆盖。"
            />
            <Button className="mt-1.5" size="sm" onClick={requestReview} disabled={pending || reason.trim().length < 5}>
              申请复核
            </Button>
            {report.reviews.length > 0 && (
              <ul className="mt-2 list-disc pl-4 text-[11px] text-inkMuted">
                {report.reviews.map((review) => (
                  <li key={review.id}>
                    {review.createdAt.slice(0, 16).replace('T', ' ')} · {review.status} · {review.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="text-xs text-inkMuted">
            <p>删除本次诊断会同时删除录音、写作原文与本轮证据；已升级的计划与历史报告不会被自动重建。</p>
            <Button variant="danger" className="mt-2" onClick={() => setDeleteOpen(true)} disabled={pending}>
              删除本次诊断会话
            </Button>
          </div>
        </div>
      </Card>

      <p className="text-[11px] text-inkMuted">{DIAG_DISCLAIMER_ZH}</p>

      <ConfirmDialog
        open={deleteOpen}
        title="删除本次诊断会话？"
        description="将删除本轮作答、录音、画像快照、报告与计划草案（含已启用的草案），并且不可恢复。历史其他诊断不受影响。"
        confirmLabel="删除"
        onConfirm={() => {
          setDeleteOpen(false);
          removeSession();
        }}
        onCancel={() => setDeleteOpen(false)}
      />
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}