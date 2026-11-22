'use client';

/** `/diagnostics` 欢迎页：背景信息 + 隐私说明 + 历史诊断入口。 */

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startDiagnosticAction } from '@/lib/actions/diagnostics';
import { DIAG_DISCLAIMER_ZH, DIAG_SESSION_STATUS_LABEL_ZH } from '@/lib/diagnostic/constants';
import { Button, buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField } from '@/components/ui/FormField';
import { Toast, useToastState } from '@/components/ui/Toast';

export interface DiagnosticsHomeProps {
  sessions: Array<{
    id: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    reportId: string | null;
    reportStatus: string | null;
  }>;
}

const GOALS = [
  { code: 'GENERAL', label: '通用英语' },
  { code: 'IELTS', label: '雅思' },
  { code: 'MEDIATED', label: '通过英语学习法语' },
  { code: 'WORK_STUDY', label: '工作 / 学习使用' },
];

export function DiagnosticsHome({ sessions }: DiagnosticsHomeProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();
  const [goals, setGoals] = useState<string[]>(['GENERAL']);
  const [includeEmlr, setIncludeEmlr] = useState(false);
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [externalAiConsent, setExternalAiConsent] = useState(false);
  const [examType, setExamType] = useState('UNCERTAIN');
  const [materials, setMaterials] = useState('');
  const [usageFrequency, setUsageFrequency] = useState('SOMETIMES');
  const [weeklyMinutes, setWeeklyMinutes] = useState('300');
  const [selfWeakness, setSelfWeakness] = useState('');

  function toggleGoal(code: string) {
    setGoals((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    );
  }

  function start() {
    startTransition(async () => {
      const result = await startDiagnosticAction({
        includeEmlr,
        goals,
        background: {
          examType,
          materials: materials || undefined,
          usageFrequency: usageFrequency as 'RARELY' | 'SOMETIMES' | 'OFTEN' | 'DAILY',
          weeklyMinutes: Number(weeklyMinutes) || undefined,
          recordingConsent,
          externalAiConsent,
          selfWeakness: selfWeakness || undefined,
        },
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      router.push(`/diagnostics/${result.data.sessionId}`);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">AI 初始诊断与智能定级</h1>
          <p className="mt-0.5 text-xs text-inkMuted">
            先建立可追溯的初始能力画像，再决定学习起点。预计 2–3 个时段，共约 40–60 分钟，可暂停续做。
          </p>
        </div>
      </div>

      <Card title="开始前的说明" dense>
        <ul className="list-disc space-y-1 pl-5 text-xs text-inkMuted">
          <li>{DIAG_DISCLAIMER_ZH}</li>
          <li>四项技能分别评估，不把等级平均成「总体 CEFR」；Grammar / Vocabulary / Sentence Structure 是辅助画像。</li>
          <li>录音与写作原文属于个人数据，只保存在本机数据库；可随时删除会话与音频。</li>
          <li>技术故障（录音失败、音频损坏）标记为无效，不会降低能力评分，可重测。</li>
          <li>你自述的强弱项只作为对照，不会直接变成等级。</li>
        </ul>
      </Card>

      <Card title="目标与背景" description="只用于制定目标与排期，不作为能力分数。">
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="学习目标（可多选）">
            <div className="flex flex-wrap gap-2">
              {GOALS.map((goal) => (
                <label key={goal.code} className="flex items-center gap-1.5 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={goals.includes(goal.code)}
                    onChange={() => toggleGoal(goal.code)}
                  />
                  {goal.label}
                </label>
              ))}
            </div>
          </FormField>

          <FormField label="雅思考试类型（可跳过）" hint="不确定时保持默认，不影响诊断。">
            <select
              className="rounded-md border border-line bg-white px-2 py-1.5 text-sm"
              value={examType}
              onChange={(event) => setExamType(event.target.value)}
            >
              <option value="UNCERTAIN">不确定 / 暂不考</option>
              <option value="ACADEMIC">Academic</option>
              <option value="GENERAL">General Training</option>
            </select>
          </FormField>

          <FormField label="过去学过的教材与时长" hint="例如 EGIU 初级 3 个月；仅作背景。">
            <input
              className="rounded-md border border-line bg-white px-2 py-1.5 text-sm"
              value={materials}
              maxLength={500}
              onChange={(event) => setMaterials(event.target.value)}
              placeholder="可留空"
            />
          </FormField>

          <FormField label="平时使用英语的频率">
            <select
              className="rounded-md border border-line bg-white px-2 py-1.5 text-sm"
              value={usageFrequency}
              onChange={(event) => setUsageFrequency(event.target.value)}
            >
              <option value="RARELY">很少</option>
              <option value="SOMETIMES">有时</option>
              <option value="OFTEN">经常</option>
              <option value="DAILY">每天</option>
            </select>
          </FormField>

          <FormField label="每周可投入时间（分钟）" hint="将用于计划草案；不会假设每天 240 分钟。">
            <input
              type="number"
              min={0}
              max={3000}
              className="rounded-md border border-line bg-white px-2 py-1.5 text-sm"
              value={weeklyMinutes}
              onChange={(event) => setWeeklyMinutes(event.target.value)}
            />
          </FormField>

          <FormField label="主观强弱项（仅作对照）">
            <input
              className="rounded-md border border-line bg-white px-2 py-1.5 text-sm"
              value={selfWeakness}
              maxLength={300}
              onChange={(event) => setSelfWeakness(event.target.value)}
              placeholder="例如：听力最弱，写作没练过"
            />
          </FormField>
        </div>

        <div className="mt-3 space-y-1.5 text-xs text-ink">
          <label className="flex items-start gap-1.5">
            <input
              type="checkbox"
              checked={recordingConsent}
              onChange={(event) => setRecordingConsent(event.target.checked)}
              className="mt-0.5"
            />
            我同意在口语任务中录音，仅用于本机诊断与我的复核；可随时删除。
          </label>
          <label className="flex items-start gap-1.5">
            <input
              type="checkbox"
              checked={externalAiConsent}
              onChange={(event) => setExternalAiConsent(event.target.checked)}
              className="mt-0.5"
            />
            我同意在启用外部 AI 时，把完成评分所需的最少作答内容发送给已配置的模型服务。
          </label>
          <label className="flex items-start gap-1.5">
            <input
              type="checkbox"
              checked={includeEmlr}
              onChange={(event) => setIncludeEmlr(event.target.checked)}
              className="mt-0.5"
            />
            加入可选的英语媒介学习准备度（EMLR）任务（不标成 CEFR 等级）。
          </label>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" onClick={start} disabled={pending || goals.length === 0}>
            {pending ? '正在创建…' : '开始诊断'}
          </Button>
          <span className="text-[11px] text-inkMuted">
            未勾选录音同意也可以做口语任务（仅文字作答）。
          </span>
        </div>
      </Card>

      <Card title="历史诊断" description="每轮诊断保留独立快照与报告，新报告不会覆盖旧报告。">
        {sessions.length === 0 ? (
          <p className="text-xs text-inkMuted">还没有诊断记录。</p>
        ) : (
          <ul className="divide-y divide-line">
            {sessions.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="text-xs text-ink">
                  <span className="font-medium">
                    {session.createdAt.slice(0, 16).replace('T', ' ')}
                  </span>
                  <span className="ml-2 text-inkMuted">
                    {DIAG_SESSION_STATUS_LABEL_ZH[
                      session.status as keyof typeof DIAG_SESSION_STATUS_LABEL_ZH
                    ] ?? session.status}
                  </span>
                  {session.reportStatus && (
                    <span className="ml-2 rounded border border-line px-1 py-0.5 text-[11px]">
                      {session.reportStatus}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {session.reportId ? (
                    <Link href={`/diagnostics/report/${session.reportId}`} className={buttonClass('secondary', 'sm')}>
                      查看报告
                    </Link>
                  ) : (
                    <Link href={`/diagnostics/${session.id}`} className={buttonClass('secondary', 'sm')}>
                      继续
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}