import { describe, expect, it } from 'vitest';
import {
  createProvider,
  FALLBACK_MODEL_CONFIG,
  resolveProviderMode,
} from '../config';
import { MockProvider, OpenAICompatibleProvider } from '../provider';

describe('Provider 选择', () => {
  it('外部模型默认关闭', () => {
    expect(
      resolveProviderMode({ externalAiEnabled: false, apiKey: 'sk-12345678', baseUrl: 'https://x' }),
    ).toEqual({ mode: 'mock', reason: 'external_disabled' });
  });

  it('缺少密钥或地址时回落 mock', () => {
    expect(
      resolveProviderMode({ externalAiEnabled: true, apiKey: undefined, baseUrl: 'https://x' }),
    ).toEqual({ mode: 'mock', reason: 'missing_api_key' });
    expect(
      resolveProviderMode({ externalAiEnabled: true, apiKey: 'short', baseUrl: 'https://x' }),
    ).toEqual({ mode: 'mock', reason: 'missing_api_key' });
    expect(
      resolveProviderMode({ externalAiEnabled: true, apiKey: 'sk-12345678', baseUrl: undefined }),
    ).toEqual({ mode: 'mock', reason: 'missing_base_url' });
    expect(
      resolveProviderMode({ externalAiEnabled: true, apiKey: 'sk-12345678', baseUrl: 'ftp://x' }),
    ).toEqual({ mode: 'mock', reason: 'missing_base_url' });
  });

  it('显式开启且配置完整时才使用外部 Provider', () => {
    expect(
      resolveProviderMode({
        externalAiEnabled: true,
        apiKey: 'sk-12345678',
        baseUrl: 'https://api.example.com/v1',
      }),
    ).toEqual({ mode: 'external', reason: 'external_ready' });
  });

  const noCredentials = {
    apiKey: undefined,
    baseUrl: '',
    modelOverride: undefined,
    source: 'none' as const,
    decryptionFailed: false,
  };

  it('mock 模式创建确定性的内置 Provider', () => {
    const provider = createProvider({
      providerMode: 'mock',
      modelConfig: FALLBACK_MODEL_CONFIG,
      credentials: noCredentials,
    });
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.mode).toBe('mock');
    expect(provider.model).toBe('mock-deterministic');
  });

  it('external 模式创建 OpenAI 兼容 Provider 并允许覆盖模型名', () => {
    const provider = createProvider({
      providerMode: 'external',
      modelConfig: FALLBACK_MODEL_CONFIG,
      credentials: {
        apiKey: 'sk-12345678',
        baseUrl: 'https://api.example.com/v1',
        modelOverride: 'model-y',
        source: 'database',
        decryptionFailed: false,
      },
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.mode).toBe('external');
    expect(provider.model).toBe('model-y');
  });
});