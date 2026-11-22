import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  maskApiKey,
  resolveProviderCredentials,
  tryDecryptSecret,
} from '../credentials';

const key = randomBytes(32);
const env = {
  apiKey: 'env-key-123456',
  baseUrl: 'https://env.example.com/v1',
  modelOverride: 'env-model',
};

describe('Provider 凭据加密', () => {
  it('AES-256-GCM 往返可解密且密文不含明文', () => {
    const cipher = encryptSecret('sk-test-1234567890', key);
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(cipher).not.toContain('sk-test');
    expect(decryptSecret(cipher, key)).toBe('sk-test-1234567890');
  });

  it('错误密钥或篡改密文都无法解密', () => {
    const cipher = encryptSecret('sk-test-1234567890', key);
    expect(tryDecryptSecret(cipher, randomBytes(32))).toBeNull();
    const parts = cipher.split(':');
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]}AA`].join(':');
    expect(tryDecryptSecret(tampered, key)).toBeNull();
  });

  it('末四位掩码不泄露完整 Key', () => {
    expect(maskApiKey('7890')).toBe('••••••••7890');
    expect(maskApiKey(null)).toBe('未配置');
  });
});

describe('凭据解析优先级', () => {
  it('数据库配置优先于环境变量', () => {
    const row = {
      baseUrl: 'https://db.example.com/v1',
      modelName: 'db-model',
      apiKeyCipher: encryptSecret('db-key-123456', key),
      apiKeyLast4: '3456',
    };
    expect(resolveProviderCredentials(row, env, key)).toEqual({
      apiKey: 'db-key-123456',
      baseUrl: 'https://db.example.com/v1',
      modelOverride: 'db-model',
      source: 'database',
      decryptionFailed: false,
    });
  });

  it('无数据库记录时回退环境变量', () => {
    expect(resolveProviderCredentials(null, env, key)).toEqual({
      apiKey: 'env-key-123456',
      baseUrl: 'https://env.example.com/v1',
      modelOverride: 'env-model',
      source: 'environment',
      decryptionFailed: false,
    });
  });

  it('密文无法解密时标记失败并回退环境变量', () => {
    const row = {
      baseUrl: '',
      modelName: '',
      apiKeyCipher: encryptSecret('other-key-123456', randomBytes(32)),
      apiKeyLast4: '3456',
    };
    expect(resolveProviderCredentials(row, env, key)).toEqual({
      apiKey: 'env-key-123456',
      baseUrl: 'https://env.example.com/v1',
      modelOverride: 'env-model',
      source: 'environment',
      decryptionFailed: true,
    });
  });

  it('数据库 Base URL 非法时回退环境变量 Base URL', () => {
    const row = {
      baseUrl: 'ftp://bad',
      modelName: '',
      apiKeyCipher: null,
      apiKeyLast4: null,
    };
    expect(resolveProviderCredentials(row, env, key).baseUrl).toBe('https://env.example.com/v1');
  });

  it('全部未配置时 source=none', () => {
    const empty = { apiKey: undefined, baseUrl: 'https://api.openai.com/v1', modelOverride: undefined };
    expect(resolveProviderCredentials(null, empty, key)).toEqual({
      apiKey: undefined,
      baseUrl: 'https://api.openai.com/v1',
      modelOverride: undefined,
      source: 'none',
      decryptionFailed: false,
    });
  });
});