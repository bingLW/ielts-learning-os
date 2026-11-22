'use client';

/**
 * AI Learning Coach 首页：创建会话 + 最近会话列表。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { startAiSessionAction } from '@/lib/actions/tutor';
import {
  AI_CEFR_LEVELS,
  AI_COACH_MODES,
  AI_COACH_MODE_LABEL_ZH,
  AI_COACH_SKILLS,
  AI_SESSION_STATUS_LABEL_ZH,
  type AiSessionStatus,
} from '@/lib/constants';
import { Button, buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField, selectClass, textareaClass } from '@/components/ui/FormField';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';

interface SessionRow {
  id: string;
  mode: string;
  skill: string;
  objective: string;
  status: string;
  provider: string;
  model: string;
  estimatedCostUsd: number;
  createdAt: Date | string;
  _count: { turns: number; evidence: number };
}

export interface AiCoachHomeProps {
  engine: {
    providerMode: 'mock' | 'external';
    providerReason: string;
    modelConfig: { label: string; model: string };
    setting: { dailyBudgetUsd: number; monthlyBudgetUsd: number; warnPercent: number };
  };
  sessions: SessionRow[];
  externalAiEnabled: boolean;
  apiKeyPresent: boolean;
  explainLanguage: string;
  directTeachingDefault: boolean;
}

const PROVIDER_REASON_ZH: Record<string, string> = {
  external_ready: '外部 Provider 已就绪',
  external_disabled: '外部 AI 未开启（设置页可开启）',
  missing_api_key: '缺少 API Key 环境变量，回落模拟模型',
  missing_base_url: '缺少 Base URL，回落模拟模型',
};

export function AiCoachHomeBody(props: AiCoachHomeProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<string>('SOCRATIC');
  const [skill, setSkill] = useState<string>('GRAMMAR');
  const [level, setLevel] = useState<string>('');
  const [objective, setObjective] = useState('');
  const [directTeaching, setDirectTeaching] = useState(props.directTeachingDefault);

  function submit() {
    startTransition(async () => {
      const result = await startAiSessionAction({
        mode,
        skill,
        objective,
        targetLevel: level || undefined,
        directTeaching,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      if (result.data.warning) show(result.data.warning, 'info');
      router.push(`/ai-coach/${result.data.sessionId}`);
    });
  }

  return (
    <div className="space-y-4">
      <Toast toast={toast} onDismiss={dismiss} />

      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">AI Learning Coach</h1>
          <p className="text-xs text-inkMuted">
            独立尝试 → 诊断 → 分级提示 → 讲解/练习 → 独立复测 → 延迟复测。AI 评估不是官方成绩。
          </p>
        </div>
        <nav className="flex gap-1.5 text-xs">
          <Link className={buttonClass('ghost', 'sm')} href="/ai-coach/review">
            Evidence Review
          </Link>
          <Link className={buttonClass('ghost', 'sm')} href="/ai-coach/usage">
            使用统计
          </Link>
          <Link className={buttonClass('ghost', 'sm')} href="/ai-coach/admin">
            模型与提示词
          </Link>
        </nav>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="当前 Provider"
          value={props.engine.providerMode === 'mock' ? '模拟模型' : '外部模型'}
          hint={props.engine.modelConfig.label}
          tone={props.engine.providerMode === 'mock' ? 'warn' : 'actual'}
          scopeNote={PROVIDER_REASON_ZH[props.engine.providerReason] ?? props.engine.providerReason}
        />
        <StatTile
          label="AI 预算（今日 / 本月）"
          value={`$${props.engine.setting.dailyBudgetUsd} / $${props.engine.setting.monthlyBudgetUsd}`}
          hint={`达到 ${props.engine.setting.warnPercent}% 预警`}
          tone="neutral"
          scopeNote="预算只统计真实外部调用；模拟调用成本为 0"
        />
        <StatTile
          label="解释语言偏好"
          value={props.explainLanguage}
          hint="可在 AI 管理页调整"
          tone="plan"
          scopeNote="A0–A1 默认中文混合解释"
        />
      </div>

      <Card
        title="新建教学会话"
        description="先独立作答，再诊断与提示；讲解与练习结果不计入独立证据。"
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="教学模式" htmlFor="ai-mode" required>
            <select
              id="ai-mode"
              className={selectClass}
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              {AI_COACH_MODES.map((item) => (
                <option key={item} value={item}>
                  {AI_COACH_MODE_LABEL_ZH[item]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="技能" htmlFor="ai-skill" required>
            <select
              id="ai-skill"
              className={selectClass}
              value={skill}
              onChange={(event) => setSkill(event.target.value)}
            >
              {AI_COACH_SKILLS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </FormField>
          <FormField
            label="目标等级（可选）"
            htmlFor="ai-level"
            hint="留空则读取技能画像；没有画像时按 A1 起步"
          >
            <select
              id="ai-level"
              className={selectClass}
              value={level}
              onChange={(event) => setLevel(event.target.value)}
            >
              <option value="">自动</option>
              {AI_CEFR_LEVELS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <FormField
          label="本次学习目标"
          htmlFor="ai-objective"
          required
          hint="例：用一般现在时描述我的一天；写一段雅思 Task 2 观点段"
          className="mt-3"
        >
          <textarea
            id="ai-objective"
            className={textareaClass}
            value={objective}
            maxLength={300}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="写清楚这次要练什么，AI 才能生成可评估的任务"
          />
        </FormField>

        <label className="mt-3 flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={directTeaching}
            onChange={(event) => setDirectTeaching(event.target.checked)}
          />
          允许直接讲解模式（结果标记为 assisted，不计入独立证据）
        </label>

        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" onClick={submit} disabled={pending || objective.trim().length < 4}>
            {pending ? '正在生成任务…' : '开始会话'}
          </Button>
          <span className="text-[11px] text-inkMuted">
            任务由 AI 生成；生成失败时会保留会话，可在详情页重试。
          </span>
        </div>
      </Card>

      <Card title="最近会话" description="点击进入会话工作台；原始作答与 AI 输出分列保存。">
        {props.sessions.length === 0 ? (
          <EmptyState
            title="还没有 AI 教学会话"
            description="先在上方创建一次会话。首版默认使用内置模拟模型，不会产生外部费用。"
            icon="bulb"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-inkMuted">
                <tr className="border-b border-line">
                  <th className="py-1.5 pr-2">创建时间</th>
                  <th className="py-1.5 pr-2">模式 / 技能</th>
                  <th className="py-1.5 pr-2">目标</th>
                  <th className="py-1.5 pr-2">状态</th>
                  <th className="py-1.5 pr-2">轮次 / 证据</th>
                  <th className="py-1.5 pr-2">模型</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {props.sessions.map((session) => (
                  <tr key={session.id} className="border-b border-line/60">
                    <td className="py-1.5 pr-2 text-inkMuted">
                      {new Date(session.createdAt).toLocaleString('zh-CN')}
                    </td>
                    <td className="py-1.5 pr-2">
                      {AI_COACH_MODE_LABEL_ZH[session.mode as keyof typeof AI_COACH_MODE_LABEL_ZH] ??
                        session.mode}
                      <span className="text-inkMuted"> / {session.skill}</span>
                    </td>
                    <td className="max-w-[240px] truncate py-1.5 pr-2" title={session.objective}>
                      {session.objective}
                    </td>
                    <td className="py-1.5 pr-2">
                      {AI_SESSION_STATUS_LABEL_ZH[session.status as AiSessionStatus] ?? session.status}
                    </td>
                    <td className="py-1.5 pr-2 tabular">
                      {session._count.turns} / {session._count.evidence}
                    </td>
                    <td className="py-1.5 pr-2 text-inkMuted">{session.model}</td>
                    <td className="py-1.5 text-right">
                      <Link className={buttonClass('secondary', 'sm')} href={`/ai-coach/${session.id}`}>
                        打开
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}