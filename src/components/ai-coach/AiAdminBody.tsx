'use client';

/**
 * AI 管理与治理页：Provider 状态、预算、模型价格、提示词版本。
 *
 * 密钥永远不在此页出现；只显示「环境变量是否已配置」。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  initPromptRegistryAction,
  updateAiEngineSettingsAction,
  updateAiModelConfigAction,
} from '@/lib/actions/tutor';
import { Button, buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass } from '@/components/ui/FormField';
import { Toast, useToastState } from '@/components/ui/Toast';

interface ModelRow {
  id: string;
  provider: string;
  model: string;
  label: string;
  active: boolean;
  isDefault: boolean;
  inputPricePerMtok: number;
  outputPricePerMtok: number;
}

interface PromptRow {
  id: string;
  promptKey: string;
  purpose: string;
  mode: string;
  versions: Array<{
    id: string;
    version: number;
    status: string;
    checksum: string;
    publishedAt: Date | string | null;
  }>;
}

export interface AiAdminProps {
  engine: {
    providerMode: 'mock' | 'external';
    providerReason: string;
    modelConfig: { label: string; model: string };
  };
  setting: {
    externalAiEnabled: boolean;
    dailyBudgetUsd: number;
    monthlyBudgetUsd: number;
    warnPercent: number;
    directTeachingDefault: boolean;
    explainLanguage: string;
  };
  models: ModelRow[];
  templates: PromptRow[];
  promptVersionCount: number;
  apiKeyPresent: boolean;
  baseUrl: string;
  modelOverride: string | null;
}

const REASON_ZH: Record<string, string> = {
  external_ready: '外部 Provider 已开启且环境变量齐备。',
  external_disabled: '外部 AI 未开启；当前使用模拟模型。',
  missing_api_key: '已开启外部 AI，但缺少 AI_PROVIDER_API_KEY 或 OPENAI_API_KEY；仍使用模拟模型。',
  missing_base_url: '已开启外部 AI，但 Base URL 不合法；仍使用模拟模型。',
};

function ModelEditor({ model }: { model: ModelRow }) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState(model.label);
  const [inputPrice, setInputPrice] = useState(String(model.inputPricePerMtok));
  const [outputPrice, setOutputPrice] = useState(String(model.outputPricePerMtok));
  const [active, setActive] = useState(model.active);
  const [isDefault, setIsDefault] = useState(model.isDefault);

  function save() {
    startTransition(async () => {
      const result = await updateAiModelConfigAction({
        id: model.id,
        label,
        inputPricePerMtok: inputPrice,
        outputPricePerMtok: outputPrice,
        active,
        isDefault,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('模型配置已保存', 'success');
      router.refresh();
    });
  }

  return (
    <div className="rounded-md border border-line p-2.5">
      <Toast toast={toast} onDismiss={dismiss} />
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-inkMuted">
        <span className="font-medium text-ink">
          {model.provider} / {model.model}
        </span>
        {model.isDefault && <span className="rounded-full border border-line px-2 py-0.5">当前默认</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <FormField label="显示名称">
          <input className={inputClass} value={label} onChange={(event) => setLabel(event.target.value)} />
        </FormField>
        <FormField label="输入价格（USD / 百万 token）">
          <input
            className={inputClass}
            type="number"
            min={0}
            step="0.01"
            value={inputPrice}
            onChange={(event) => setInputPrice(event.target.value)}
          />
        </FormField>
        <FormField label="输出价格（USD / 百万 token）">
          <input
            className={inputClass}
            type="number"
            min={0}
            step="0.01"
            value={outputPrice}
            onChange={(event) => setOutputPrice(event.target.value)}
          />
        </FormField>
        <div className="flex flex-col justify-end gap-1 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
            启用
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />
            设为默认
          </label>
        </div>
      </div>
      <Button variant="secondary" size="sm" className="mt-2" disabled={pending} onClick={save}>
        保存模型配置
      </Button>
    </div>
  );
}

export function AiAdminBody(props: AiAdminProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();
  const [setting, setSetting] = useState(props.setting);

  function saveSettings() {
    startTransition(async () => {
      const result = await updateAiEngineSettingsAction({
        externalAiEnabled: setting.externalAiEnabled,
        dailyBudgetUsd: setting.dailyBudgetUsd,
        monthlyBudgetUsd: setting.monthlyBudgetUsd,
        warnPercent: setting.warnPercent,
        directTeachingDefault: setting.directTeachingDefault,
        explainLanguage: setting.explainLanguage as 'ZH_MIXED' | 'ZH' | 'EN',
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('引擎设置已保存', 'success');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Toast toast={toast} onDismiss={dismiss} />

      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">AI 模型与提示词管理</h1>
          <p className="text-xs text-inkMuted">
            所有模型请求由后端代理；此页不显示、也不存储密钥。
          </p>
        </div>
        <Link className={buttonClass('ghost', 'sm')} href="/ai-coach">
          ← 返回 AI Learning Coach
        </Link>
      </header>

      <Card title="Provider 状态">
        <ul className="space-y-1 text-xs">
          <li>
            当前运行：<strong>{props.engine.providerMode === 'mock' ? '模拟模型' : '外部模型'}</strong>
            （{props.engine.modelConfig.label} / {props.engine.modelConfig.model}）
          </li>
          <li>判定原因：{REASON_ZH[props.engine.providerReason] ?? props.engine.providerReason}</li>
          <li>API Key 环境变量：{props.apiKeyPresent ? '已配置（不显示内容）' : '未配置'}</li>
          <li>Base URL：{props.baseUrl}</li>
          <li>模型覆盖变量：{props.modelOverride ?? '未设置'}</li>
          <li className="text-inkMuted">
            需要配置的环境变量：AI_PROVIDER_API_KEY（或 OPENAI_API_KEY）、AI_PROVIDER_BASE_URL、
            可选 AI_PROVIDER_MODEL。
          </li>
        </ul>
      </Card>

      <Card title="引擎设置" description="外部 AI 默认关闭；预算超限时调用会被拦截并记录 BLOCKED。">
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={setting.externalAiEnabled}
              onChange={(event) =>
                setSetting((prev) => ({ ...prev, externalAiEnabled: event.target.checked }))
              }
            />
            允许外部 AI（需环境变量密钥）
          </label>
          <FormField label="每日预算（USD）">
            <input
              className={inputClass}
              type="number"
              min={0}
              step="0.1"
              value={setting.dailyBudgetUsd}
              onChange={(event) =>
                setSetting((prev) => ({ ...prev, dailyBudgetUsd: Number(event.target.value) }))
              }
            />
          </FormField>
          <FormField label="每月预算（USD）">
            <input
              className={inputClass}
              type="number"
              min={0}
              step="1"
              value={setting.monthlyBudgetUsd}
              onChange={(event) =>
                setSetting((prev) => ({ ...prev, monthlyBudgetUsd: Number(event.target.value) }))
              }
            />
          </FormField>
          <FormField label="预警比例（%）">
            <input
              className={inputClass}
              type="number"
              min={50}
              max={100}
              value={setting.warnPercent}
              onChange={(event) =>
                setSetting((prev) => ({ ...prev, warnPercent: Number(event.target.value) }))
              }
            />
          </FormField>
          <FormField label="解释语言">
            <select
              className={selectClass}
              value={setting.explainLanguage}
              onChange={(event) =>
                setSetting((prev) => ({ ...prev, explainLanguage: event.target.value }))
              }
            >
              <option value="ZH_MIXED">中文 + 简单英语（推荐 A0–A1）</option>
              <option value="ZH">中文为主</option>
              <option value="EN">英文为主</option>
            </select>
          </FormField>
          <label className="flex items-end gap-2 pb-1.5 text-xs">
            <input
              type="checkbox"
              checked={setting.directTeachingDefault}
              onChange={(event) =>
                setSetting((prev) => ({ ...prev, directTeachingDefault: event.target.checked }))
              }
            />
            新建会话默认允许直接讲解
          </label>
        </div>
        <Button variant="primary" size="sm" className="mt-3" disabled={pending} onClick={saveSettings}>
          保存引擎设置
        </Button>
      </Card>

      <Card title="模型配置" description="价格只用于成本估算；模拟模型价格为 0。">
        <div className="space-y-2">
          {props.models.map((model) => (
            <ModelEditor key={model.id} model={model} />
          ))}
        </div>
      </Card>

      <Card
        title="Prompt Registry"
        description={`共 ${props.promptVersionCount} 个版本；已发布版本只追加、不覆盖。`}
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await initPromptRegistryAction();
                if (!result.ok) {
                  show(result.error, 'error');
                  return;
                }
                show(`已同步 ${result.data.prompts} 个提示词`, 'success');
                router.refresh();
              })
            }
          >
            初始化 / 同步提示词
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-inkMuted">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-2">Prompt Key</th>
                <th className="py-1.5 pr-2">用途</th>
                <th className="py-1.5 pr-2">最新版本</th>
                <th className="py-1.5 pr-2">状态</th>
                <th className="py-1.5 pr-2">校验和</th>
                <th className="py-1.5">发布时间</th>
              </tr>
            </thead>
            <tbody>
              {props.templates.map((template) => {
                const latest = template.versions[0];
                return (
                  <tr key={template.id} className="border-b border-line/60">
                    <td className="py-1.5 pr-2 font-mono text-[11px]">{template.promptKey}</td>
                    <td className="max-w-[240px] truncate py-1.5 pr-2" title={template.purpose}>
                      {template.purpose}
                    </td>
                    <td className="py-1.5 pr-2 tabular">v{latest?.version ?? '—'}</td>
                    <td className="py-1.5 pr-2">{latest?.status ?? '—'}</td>
                    <td className="py-1.5 pr-2 font-mono text-[11px]">{latest?.checksum ?? '—'}</td>
                    <td className="py-1.5 text-inkMuted">
                      {latest?.publishedAt
                        ? new Date(latest.publishedAt).toLocaleString('zh-CN')
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}