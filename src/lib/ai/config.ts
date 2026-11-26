/**
 * AI Engine 配置解析。
 *
 * 规则：
 * 1. 外部模型默认关闭；只有设置页显式开启且凭据齐备才启用；
 * 2. 否则一律回落 mock，并在调用日志里标记为模拟，不产生费用；
 * 3. 凭据解析优先级：管理页配置（加密入库）> 环境变量 > 未配置；
 *    明文密钥只存在于服务端内存，不返回前端。
 */

import type { PrismaClient } from '@prisma/client';
import { AI_ENGINE_DEFAULTS, TZ_NAME } from '@/lib/constants';
import { isValidTimeZone } from '@/lib/date';
import {
  resolveProviderCredentials,
  type ProviderCredentials,
} from './credentials';
import { MockProvider, OpenAICompatibleProvider } from './provider';
import type { AiProvider } from './types';

export type ProviderMode = 'mock' | 'external';

export type ProviderReason =
  | 'external_ready'
  | 'external_disabled'
  | 'missing_api_key'
  | 'missing_base_url';

export interface ProviderEnvInput {
  externalAiEnabled: boolean;
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

export function resolveProviderMode(input: ProviderEnvInput): {
  mode: ProviderMode;
  reason: ProviderReason;
} {
  if (!input.externalAiEnabled) return { mode: 'mock', reason: 'external_disabled' };
  if (!input.apiKey || input.apiKey.trim().length < 8) {
    return { mode: 'mock', reason: 'missing_api_key' };
  }
  if (!input.baseUrl || !/^https?:\/\//.test(input.baseUrl.trim())) {
    return { mode: 'mock', reason: 'missing_base_url' };
  }
  return { mode: 'external', reason: 'external_ready' };
}

export function readProviderEnv(): {
  apiKey: string | undefined;
  baseUrl: string;
  modelOverride: string | undefined;
} {
  return {
    apiKey: process.env.AI_PROVIDER_API_KEY ?? process.env.OPENAI_API_KEY,
    baseUrl: process.env.AI_PROVIDER_BASE_URL ?? 'https://api.openai.com/v1',
    modelOverride: process.env.AI_PROVIDER_MODEL,
  };
}

export interface EngineSettingLike {
  externalAiEnabled: boolean;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  warnPercent: number;
  directTeachingDefault: boolean;
  explainLanguage: string;
}

export interface ModelConfigLike {
  id: string;
  provider: string;
  model: string;
  label: string;
  inputPricePerMtok: number;
  outputPricePerMtok: number;
  active: boolean;
}

export const DEFAULT_ENGINE_SETTING: EngineSettingLike = {
  externalAiEnabled: false,
  dailyBudgetUsd: AI_ENGINE_DEFAULTS.dailyBudgetUsd,
  monthlyBudgetUsd: AI_ENGINE_DEFAULTS.monthlyBudgetUsd,
  warnPercent: AI_ENGINE_DEFAULTS.warnPercent,
  directTeachingDefault: false,
  explainLanguage: 'ZH_MIXED',
};

export const FALLBACK_MODEL_CONFIG: ModelConfigLike = {
  id: 'fallback-mock',
  provider: 'mock',
  model: 'mock-deterministic',
  label: '内置模拟模型',
  inputPricePerMtok: 0,
  outputPricePerMtok: 0,
  active: true,
};

export interface ResolvedEngineConfig {
  setting: EngineSettingLike;
  modelConfig: ModelConfigLike;
  credentials: ProviderCredentials;
  providerMode: ProviderMode;
  providerReason: ProviderReason;
  /** 预算日/月窗口使用的用户 IANA 时区。 */
  timeZone: string;
}

export async function loadEngineConfig(prisma: PrismaClient): Promise<ResolvedEngineConfig> {
  const [settingRow, modelRow, credentialRow, profile] = await Promise.all([
    prisma.aIEngineSetting.findUnique({ where: { id: 'default' } }),
    prisma.aIModelConfig.findFirst({
      where: { isDefault: true, active: true },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.aIProviderCredential.findUnique({ where: { id: 'default' } }),
    prisma.userProfile.findUnique({ where: { id: 1 }, select: { timezone: true } }),
  ]);

  const setting: EngineSettingLike = settingRow
    ? {
        externalAiEnabled: settingRow.externalAiEnabled,
        dailyBudgetUsd: settingRow.dailyBudgetUsd,
        monthlyBudgetUsd: settingRow.monthlyBudgetUsd,
        warnPercent: settingRow.warnPercent,
        directTeachingDefault: settingRow.directTeachingDefault,
        explainLanguage: settingRow.explainLanguage,
      }
    : DEFAULT_ENGINE_SETTING;

  const modelConfig: ModelConfigLike = modelRow
    ? {
        id: modelRow.id,
        provider: modelRow.provider,
        model: modelRow.model,
        label: modelRow.label,
        inputPricePerMtok: modelRow.inputPricePerMtok,
        outputPricePerMtok: modelRow.outputPricePerMtok,
        active: modelRow.active,
      }
    : FALLBACK_MODEL_CONFIG;

  const credentials = resolveProviderCredentials(credentialRow, readProviderEnv());
  const { mode, reason } = resolveProviderMode({
    externalAiEnabled: setting.externalAiEnabled,
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
  });

  return {
    setting,
    modelConfig,
    credentials,
    providerMode: mode,
    providerReason: reason,
    timeZone: profile?.timezone && isValidTimeZone(profile.timezone) ? profile.timezone : TZ_NAME,
  };
}

export function createProvider(
  config: Pick<ResolvedEngineConfig, 'providerMode' | 'modelConfig' | 'credentials'>,
): AiProvider {
  const { credentials } = config;
  if (config.providerMode === 'external') {
    return new OpenAICompatibleProvider({
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey ?? '',
      model: credentials.modelOverride ?? config.modelConfig.model,
    });
  }
  return new MockProvider(config.modelConfig.model || 'mock-deterministic');
}