'use client';

/**
 * AI 管理与治理页：Provider 状态、凭据、预算、模型价格、提示词版本。
 *
 * 密钥可在此页填写，加密后存入本机数据库；页面只回显末四位，永不回显明文。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  initPromptRegistryAction,
  saveProviderCredentialAction,
  updateAiEngineSettingsAction,
  updateExternalAiConsentAction,
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
    updatedAt: Date | string;
  };
  externalAiConsent: boolean;
  models: ModelRow[];
  templates: PromptRow[];
  promptVersionCount: number;
  credential: {
    baseUrl: string;
    modelName: string;
    apiKeyConfigured: boolean;
    apiKeyLast4: string | null;
    source: 'database' | 'environment' | 'none';
    decryptionFailed: boolean;
  };
}

const REASON_ZH: Record<string, string> = {
  external_ready: '外部 Provider 已开启且凭据齐备。',
  external_disabled: '外部 AI 未开启；当前使用模拟模型。',
  missing_api_key: '已开启外部 AI，但尚未配置 API Key（本页或环境变量）；仍使用模拟模型。',
  missing_base_url: '已开启外部 AI，但 Base URL 不合法；仍使用模拟模型。',
};

const SOURCE_ZH: Record<AiAdminProps['credential']['source'], string> = {
  database: '管理页配置（已加密入库）',
  environment: '环境变量（回退）',
  none: '未配置',
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
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(props.credential.baseUrl);
  const [modelName, setModelName] = useState(props.credential.modelName);
  const [consentAcknowledged, setConsentAcknowledged] = useState(false);

  function saveConsent() {
    if (!props.externalAiConsent && !consentAcknowledged) return;
    startTransition(async () => {
      const result = await updateExternalAiConsentAction({
        externalAiConsent: !props.externalAiConsent,
        acknowledged: true,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      setConsentAcknowledged(false);
      show(props.externalAiConsent ? '已撤回外部 AI 外发同意' : '已记录外部 AI 外发同意', 'success');
      router.refresh();
    });
  }

  function saveCredential(clearApiKey = false) {
    startTransition(async () => {
      const result = await saveProviderCredentialAction({
        baseUrl,
        modelName,
        apiKey: clearApiKey ? undefined : apiKey.trim() || undefined,
        clearApiKey,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      setApiKey('');
      show(
        clearApiKey
          ? '已清除 API Key；外部调用将回落模拟模型'
          : 'Provider 凭据已保存（密钥已加密入库）',
        'success',
      );
      router.refresh();
    });
  }

  function saveSettings() {
    startTransition(async () => {
      const result = await updateAiEngineSettingsAction({
        externalAiEnabled: setting.externalAiEnabled,
        dailyBudgetUsd: setting.dailyBudgetUsd,
        monthlyBudgetUsd: setting.monthlyBudgetUsd,
        warnPercent: setting.warnPercent,
        directTeachingDefault: setting.directTeachingDefault,
        explainLanguage: setting.explainLanguage as 'ZH_MIXED' | 'ZH' | 'EN',
        expectedUpdatedAt: props.setting.updatedAt,
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
            所有模型请求由后端代理；API Key 加密后存入本机数据库，页面只回显末四位。
          </p>
        </div>
        <Link className={buttonClass('ghost', 'sm')} href="/ai-coach">
          ← 返回 AI Learning Coach
        </Link>
      </header>

      <Card title="首次外发告知与独立同意">
        <div className="space-y-2 text-xs text-inkMuted">
          <p>
            启用外部 Provider 后，系统只会把本次诊断/练习所需的作答片段、题目与必要的学习上下文发往本页配置的第三方服务；不会发送 API Key、完整历史或与本次任务无关的材料。
          </p>
          <p>第三方调用可能产生费用，并受其数据处理政策约束。发送前会统一脱敏路径、邮箱、密钥与文件 URL。</p>
          <p className="font-medium text-ink">
            未单独同意时不会调用外部 Provider；“允许外部 AI”只是技术开关，不代表你已同意外发。
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={props.externalAiConsent || consentAcknowledged}
              disabled={props.externalAiConsent}
              onChange={(event) => setConsentAcknowledged(event.target.checked)}
              className="mt-0.5"
            />
            <span>我已了解上述内容，并同意将必要作答片段发往配置的第三方 Provider。</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={props.externalAiConsent ? 'secondary' : 'primary'}
              size="sm"
              disabled={pending || (!props.externalAiConsent && !consentAcknowledged)}
              onClick={saveConsent}
            >
              {props.externalAiConsent ? '撤回外部 AI 外发同意' : '同意并保存'}
            </Button>
            <span>当前状态：{props.externalAiConsent ? '已同意' : '未同意（外部调用将被拦截）'}</span>
          </div>
        </div>
      </Card>

      <Card title="Provider 状态">
        <ul className="space-y-1 text-xs">
          <li>
            当前运行：<strong>{props.engine.providerMode === 'mock' ? '模拟模型' : '外部模型'}</strong>
            （{props.engine.modelConfig.label} / {props.engine.modelConfig.model}）
          </li>
          <li>判定原因：{REASON_ZH[props.engine.providerReason] ?? props.engine.providerReason}</li>
          <li>凭据来源：{SOURCE_ZH[props.credential.source]}</li>
          <li>
            API Key：
            {props.credential.apiKeyConfigured
              ? `已配置（末四位 ${props.credential.apiKeyLast4 ?? '****'}）`
              : '未配置'}
          </li>
          <li>Base URL：{props.credential.baseUrl}</li>
          <li>外部调用模型：{props.credential.modelName}</li>
          {props.credential.decryptionFailed && (
            <li className="text-egRed">
              数据库中的密钥无法解密（本机密钥文件缺失或已更换），请在本页重新填写 API Key。
            </li>
          )}
        </ul>
      </Card>

      <Card
        title="Provider 凭据"
        description="在此页填写后立即生效；API Key 使用 AES-256-GCM 加密存入本机 SQLite，不回显明文。"
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <FormField label="API Key">
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                props.credential.apiKeyConfigured
                  ? `已保存（末四位 ${props.credential.apiKeyLast4 ?? '****'}），留空保持不变`
                  : '尚未配置；粘贴后保存'
              }
            />
          </FormField>
          <FormField label="Base URL">
            <input
              className={inputClass}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </FormField>
          <FormField label="模型名">
            <input
              className={inputClass}
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              placeholder="gpt-4o-mini"
            />
          </FormField>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={pending} onClick={() => saveCredential()}>
            保存凭据
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending || !props.credential.apiKeyConfigured}
            onClick={() => saveCredential(true)}
          >
            清除 API Key
          </Button>
          <span className="text-xs text-inkMuted">
            加密密钥：环境变量 AI_CREDENTIALS_SECRET，或本机 .local/ai-credentials.key（自动生成）。
          </span>
        </div>
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
            允许外部 AI（技术开关，需凭据与独立外发同意）
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